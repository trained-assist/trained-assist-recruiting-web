import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { createRecruitingConnectedAppBff, createMemoryConnectedAppBffStore } from '../src/connected-app-bff.js';
import { createMemoryAcceptedReportDraftStore } from '../src/accepted-report-drafts.js';
import { SqliteAcceptedReportDraftStore } from '../src/sqlite-accepted-report-draft-store.js';
import { createRecruitingServer } from '../src/server.js';

const issuer = 'https://cp.example.test';
const publicOrigin = 'https://recruiting.example.test';
const profileOne = 'profile_owner_one';
const profileTwo = 'profile_owner_two';
const vacancyId = 'vacancy_owned_one';
const candidateId = 'candidate_accepted_one';
const sourceRevision = 'a'.repeat(64);
const now = Date.parse('2026-10-06T09:00:00Z');
const requestedScopes = ['recruiting.reports.read', 'recruiting.reports.create', 'recruiting.reports.review'];
const sourceBase = {
  domainApiVersion: 'v1', profileId: profileOne, vacancyId, candidateId, sourceRevision,
  sourceKind: 'accepted_cold_search', publication: 'disabled',
  clientDraftFields: {
    candidateName: 'Synthetic Candidate', position: 'Platform Engineer', vacancyTitle: 'Staff Platform Engineer',
    experience: [{ role: 'Engineer', company: 'Example Works', period: '2021 — 2025' }],
  },
  internalAssessment: { atsScore: 9, atsTag: 'PASS', reviewStatus: 'starred',
    internalComment: 'INTERNAL_PRIVATE_COMMENT', criteriaRevision: 'CRITERIA_PRIVATE' },
  salary: 'SALARY_PRIVATE', email: 'candidate@example.invalid', hhUrl: 'https://hh.example.invalid/private-resume',
  recruiterComment: 'RECRUITER_PRIVATE_COMMENT', atsContext: 'ATS_CONTEXT_PRIVATE',
};

function cookieValue(response, name) {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = setCookie.match(new RegExp(`${name}=([^;,]+)`));
  return match?.[1] ?? null;
}

function claimsFor(token) {
  const profileId = token[0] === 'b' ? profileTwo : profileOne;
  return { active: true, iss: issuer, aud: 'recruiting-web', sub: `actor_${profileId}`,
    profileId, sessionId: `session_${profileId}`, nbf: now / 1000 - 30,
    exp: now / 1000 + 300, scopes: requestedScopes };
}

async function connect(base, tokenChar = 'a') {
  const start = await fetch(`${base}/auth/connected/start?from=report&vacancy_id=${vacancyId}&candidate_id=${candidateId}`, { redirect: 'manual' });
  assert.equal(start.status, 303);
  assert.match(start.headers.get('location'), /\/authorize\?/);
  const pending = cookieValue(start, '__Host-recruiting-oauth-pending');
  assert.ok(pending);
  const authorize = new URL(start.headers.get('location'));
  const token = tokenChar.repeat(64);
  const callback = new URL('/auth/connected/callback', base);
  callback.searchParams.set('code', token);
  callback.searchParams.set('state', authorize.searchParams.get('state'));
  callback.searchParams.set('iss', issuer);
  const completed = await fetch(callback, { redirect: 'manual', headers: { cookie: `__Host-recruiting-oauth-pending=${pending}` } });
  assert.equal(completed.status, 303);
  const session = cookieValue(completed, '__Host-recruiting-app-session');
  assert.ok(session);
  const cookie = `__Host-recruiting-app-session=${session}`;
  const sessionResponse = await fetch(`${base}/auth/connected/session`, { headers: { cookie } });
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json();
  return { cookie, csrfToken: sessionBody.csrfToken, session: sessionBody };
}

test('accepted report UI uses real BFF handlers, profile-owned source, private draft, preview and explicit human review', async t => {
  const originalLog = console.log; const originalWarn = console.warn; const originalError = console.error;
  const capturedLogs = [];
  console.log = (...args) => capturedLogs.push(args.join(' '));
  console.warn = (...args) => capturedLogs.push(args.join(' '));
  console.error = (...args) => capturedLogs.push(args.join(' '));
  t.after(() => { console.log = originalLog; console.warn = originalWarn; console.error = originalError; });
  let revision = sourceRevision;
  let sourceReads = 0;
  let hhCalls = 0; let modelCalls = 0; let sendCalls = 0; let publishCalls = 0;
  const sourceRead = async (context, request) => {
    sourceReads++;
    if (context.profileId !== profileOne || request.vacancyId !== vacancyId || request.candidateId !== candidateId)
      return { status: 404, body: { error: 'not_found' } };
    return { status: 200, body: { ...structuredClone(sourceBase), sourceRevision: revision } };
  };
  const bff = createRecruitingConnectedAppBff({ issuer, allowedIssuerOrigins: [issuer], publicOrigin,
    redirectUri: `${publicOrigin}/auth/connected/callback`, store: createMemoryConnectedAppBffStore(),
    clock: () => now, exchangeCode: async ({ code }) => ({ token: code, expiresAt: now / 1000 + 300 }),
    introspectToken: async token => claimsFor(token) });
  const draftStore = createMemoryAcceptedReportDraftStore();
  const server = createRecruitingServer({ connectedAppBff: bff, acceptedReportSourceRead: sourceRead,
    acceptedReportDraftStore: draftStore });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const pageRedirect = await fetch(`${base}/hh/candidate-report?vacancy_id=${vacancyId}&candidate_id=${candidateId}`, { redirect: 'manual' });
  assert.equal(pageRedirect.status, 303);
  assert.match(pageRedirect.headers.get('location'), /from=report/);
  const connected = await connect(base);
  assert.deepEqual(connected.session.scopes, requestedScopes);
  const page = await fetch(`${base}/hh/candidate-report?vacancy_id=${vacancyId}&candidate_id=${candidateId}`, { headers: { cookie: connected.cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Черновик отчёта кандидата/);

  // Missing Origin/CSRF is rejected before the source or draft handler can run.
  const unauthorized = await fetch(`${base}/api/v1/ui/accepted-report-drafts`, { method: 'POST',
    headers: { cookie: connected.cookie, 'content-type': 'application/json', 'Idempotency-Key': 'r04-create-unsafe-001' },
    body: JSON.stringify({ candidateId, vacancyId, expectedSourceRevision: sourceRevision }) });
  assert.equal(unauthorized.status, 401);
  assert.equal(sourceReads, 0);

  const sourceUrl = new URL('/api/v1/ui/accepted-report-client-source', base);
  sourceUrl.searchParams.set('vacancyId', vacancyId); sourceUrl.searchParams.set('candidateId', candidateId);
  const sourceResponse = await fetch(sourceUrl, { headers: { cookie: connected.cookie } });
  assert.equal(sourceResponse.status, 200);
  const source = await sourceResponse.json();
  assert.equal(source.sourceRevision, sourceRevision);
  assert.equal(source.clientDraftFields.candidateName, 'Synthetic Candidate');
  assert.equal('internalAssessment' in source, false, 'the browser source route omits the internal audience entirely');
  assert.equal(JSON.stringify(source).includes('INTERNAL_PRIVATE_COMMENT'), false);
  assert.equal(JSON.stringify(source).includes('candidate@example.invalid'), false);

  const startDraft = await fetch(`${base}/api/v1/ui/accepted-report-drafts`, { method: 'POST',
    headers: { cookie: connected.cookie, origin: publicOrigin, 'x-csrf-token': connected.csrfToken,
      'content-type': 'application/json', 'Idempotency-Key': 'r04-create-private-001' },
    body: JSON.stringify({ candidateId, vacancyId, expectedSourceRevision: sourceRevision }) });
  assert.equal(startDraft.status, 201);
  const draft = await startDraft.json();
  assert.match(draft.reportRef, /^report_[a-f0-9]{32}$/);
  assert.equal(draft.sourceRevision, sourceRevision);
  assert.equal(draft.reviewState, 'unreviewed');
  assert.equal(JSON.stringify(draft).includes('INTERNAL_PRIVATE_COMMENT'), false);
  assert.equal(JSON.stringify(draft).includes('candidate@example.invalid'), false);
  assert.equal(JSON.stringify(draft).includes('SALARY_PRIVATE'), false);
  assert.equal(JSON.stringify(draft).includes('ATS_CONTEXT_PRIVATE'), false);
  const schema = JSON.parse(await readFile(new URL('../contracts/v1-accepted-report-draft.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate(draft), true, JSON.stringify(validate.errors));

  const previewResponse = await fetch(`${base}/api/v1/ui/accepted-report-drafts/${draft.reportRef}/preview`, { headers: { cookie: connected.cookie } });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.previewOnly, true);
  assert.equal(preview.publication, 'not_shared');
  assert.match(preview.html, /ЧЕРНОВИК · ТРЕБУЕТ ПРОВЕРКИ · НЕ ОТПРАВЛЕН/);
  assert.match(preview.html, /Synthetic Candidate/);
  for (const privateText of ['INTERNAL_PRIVATE_COMMENT', 'candidate@example.invalid', 'SALARY_PRIVATE', 'ATS_CONTEXT_PRIVATE', 'RECRUITER_PRIVATE_COMMENT'])
    assert.equal(preview.html.includes(privateText), false);
  assert.equal(preview.html.includes('https://hh.example.invalid'), false);
  assert.equal(JSON.stringify(preview).includes('internalAssessment'), false);

  const foreign = await connect(base, 'b');
  const foreignRead = await fetch(`${base}/api/v1/ui/accepted-report-drafts/${draft.reportRef}`, { headers: { cookie: foreign.cookie } });
  assert.equal(foreignRead.status, 404, 'another connected profile cannot read the draft');
  const foreignCreate = await fetch(`${base}/api/v1/ui/accepted-report-drafts`, { method: 'POST',
    headers: { cookie: foreign.cookie, origin: publicOrigin, 'x-csrf-token': foreign.csrfToken,
      'content-type': 'application/json', 'Idempotency-Key': 'r04-create-foreign-001' },
    body: JSON.stringify({ candidateId, vacancyId, expectedSourceRevision: sourceRevision }) });
  assert.equal(foreignCreate.status, 404, 'foreign profile cannot reuse another profile vacancy/source');

  revision = 'b'.repeat(64);
  const staleRead = await fetch(`${base}/api/v1/ui/accepted-report-drafts/${draft.reportRef}`, { headers: { cookie: connected.cookie } });
  assert.equal(staleRead.status, 409);
  assert.equal('report' in await staleRead.json(), false, 'stale client fields are not returned as a current report');
  const stalePreview = await fetch(`${base}/api/v1/ui/accepted-report-drafts/${draft.reportRef}/preview`, { headers: { cookie: connected.cookie } });
  assert.equal(stalePreview.status, 409);
  assert.equal((await stalePreview.json()).error, 'stale_report_source');
  revision = sourceRevision;
  const review = await fetch(`${base}/api/v1/ui/accepted-report-drafts/${draft.reportRef}/review`, { method: 'POST',
    headers: { cookie: connected.cookie, origin: publicOrigin, 'x-csrf-token': connected.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', expectedReportRevision: draft.reportRevision }) });
  assert.equal(review.status, 200);
  const approved = await review.json();
  assert.equal(approved.reviewState, 'approved');
  assert.equal(approved.sourceRevision, sourceRevision);
  assert.equal(sendCalls + publishCalls + hhCalls + modelCalls, 0);

  const forbiddenPublish = await fetch(`${base}/api/v1/ui/accepted-report-drafts/${draft.reportRef}/publish`, { method: 'POST',
    headers: { cookie: connected.cookie, origin: publicOrigin, 'x-csrf-token': connected.csrfToken,
      'content-type': 'application/json' }, body: JSON.stringify({ expectedReportRevision: approved.reportRevision }) });
  assert.equal(forbiddenPublish.status, 405);
  const publicShare = await fetch(`${base}/api/v1/reports/${draft.reportRef}`, { headers: { cookie: connected.cookie } });
  assert.equal(publicShare.status, 404);
  assert.equal(sendCalls + publishCalls + hhCalls + modelCalls, 0);
  assert.deepEqual(capturedLogs, [], 'report names, source data, cookies, and tokens are not logged');
});

test('SQLite report drafts survive restart, encrypt candidate fields at rest, and enforce optimistic review', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'r04-private-')));
  await import('node:fs/promises').then(fs => fs.chmod(dir, 0o700));
  const filename = join(dir, 'reports.sqlite');
  const key = '4'.repeat(64);
  const nowDate = new Date('2026-10-06T09:00:00.000Z');
  let revision = sourceRevision;
  const sourceRead = async context => ({ status: 200, body: { ...structuredClone(sourceBase),
    profileId: context.profileId, sourceRevision: revision } });
  const context = { profileId: profileOne, scopes: requestedScopes };
  const request = { candidateId, vacancyId, expectedSourceRevision: sourceRevision };
  const firstStore = new SqliteAcceptedReportDraftStore({ filename, encryptionKey: key });
  const firstDomain = (await import('../src/accepted-report-drafts.js')).createAcceptedReportDrafts({
    sourceRead, store: firstStore, clock: () => nowDate });
  const created = await firstDomain.create(context, 'r04-persist-restart-001', request);
  assert.equal(created.kind, 'created');
  const ref = created.report.reportRef;
  firstStore.close();
  const mode = (await stat(filename)).mode & 0o777;
  assert.equal(mode, 0o600);
  const bytes = await readFile(filename);
  for (const privateText of ['Synthetic Candidate', 'INTERNAL_PRIVATE_COMMENT', 'candidate@example.invalid', 'ATS_CONTEXT_PRIVATE'])
    assert.equal(bytes.includes(Buffer.from(privateText)), false, `${privateText} is encrypted or excluded at rest`);

  const secondStore = new SqliteAcceptedReportDraftStore({ filename, encryptionKey: key });
  t.after(async () => { secondStore.close(); await rm(dir, { recursive: true, force: true }); });
  const secondDomain = (await import('../src/accepted-report-drafts.js')).createAcceptedReportDrafts({
    sourceRead, store: secondStore, clock: () => nowDate });
  const loaded = await secondDomain.get(context, ref);
  assert.equal(loaded.kind, 'found');
  assert.equal(loaded.report.sourceRevision, sourceRevision);
  assert.equal(loaded.report.clientFields.candidateName, 'Synthetic Candidate');
  const internal = secondStore.get(profileOne, ref);
  assert.equal(internal.audit.length, 1);
  assert.equal(internal.audit[0].actorProfileId, profileOne);
  assert.equal(secondStore.get(profileTwo, ref), null);
  const approved = await secondDomain.review(context, ref, 'report-r1', 'approved');
  assert.equal(approved.kind, 'reviewed');
  assert.equal(approved.report.reviewState, 'approved');
  assert.equal((await secondDomain.review(context, ref, 'report-r1', 'approved')).kind, 'stale_report');

  revision = 'c'.repeat(64);
  assert.equal((await secondDomain.preview(context, ref)).kind, 'stale_source');
});
