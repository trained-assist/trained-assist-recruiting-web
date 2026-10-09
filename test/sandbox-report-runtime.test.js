import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSandboxReportState, createSandboxReportRuntime, sandboxReportFixture } from '../src/sandbox-report-runtime.js';

const publicOrigin = 'https://trained-assist-recruiting-web-sandbox-bridge.skillset-apply.workers.dev';

function cookie(response, name) {
  const value = response.headers.get('set-cookie') ?? '';
  return value.match(new RegExp(`${name}=([^;,]+)`))?.[1] ?? null;
}

async function connect(base, from = 'report', source = sandboxReportFixture) {
  const startPath = from === 'report'
    ? `/auth/connected/start?from=report&vacancy_id=${source.vacancyId}&candidate_id=${source.candidateId}`
    : '/auth/connected/start?from=proactive&vacancy_id=vac_demo_001';
  const start = await fetch(`${base}${startPath}`, { redirect: 'manual' });
  assert.equal(start.status, 303);
  const pending = cookie(start, '__Host-recruiting-oauth-pending');
  assert.ok(pending);
  const authorizeUrl = new URL(start.headers.get('location'));
  const authorize = await fetch(`${base}${authorizeUrl.pathname}${authorizeUrl.search}`, {
    redirect: 'manual', headers: { cookie: `__Host-recruiting-oauth-pending=${pending}` },
  });
  assert.equal(authorize.status, 303);
  const callbackUrl = new URL(authorize.headers.get('location'));
  const callback = await fetch(`${base}${callbackUrl.pathname}${callbackUrl.search}`, {
    redirect: 'manual', headers: { cookie: `__Host-recruiting-oauth-pending=${pending}` },
  });
  assert.equal(callback.status, 303);
  const session = cookie(callback, '__Host-recruiting-app-session');
  assert.ok(session);
  const sessionCookie = `__Host-recruiting-app-session=${session}`;
  const sessionResponse = await fetch(`${base}/auth/connected/session`, { headers: { cookie: sessionCookie } });
  assert.equal(sessionResponse.status, 200);
  return { cookie: sessionCookie, csrfToken: (await sessionResponse.json()).csrfToken };
}

test('opt-in sandbox runs accepted report HTTP/BFF/SQLite flow with isolated synthetic profiles', async t => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'recruiting-sandbox-report-'));
  await rm(stateDirectory, { recursive: true, force: true });
  const state = await ensureSandboxReportState(stateDirectory);
  const server = createSandboxReportRuntime({ publicOrigin, reportDraftsDbPath: state.databasePath,
    encryptionKey: state.key });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const sandboxLogin = await fetch(`${base}/__sandbox-login`, { redirect: 'manual' });
  assert.equal(sandboxLogin.status, 303);
  assert.match(sandboxLogin.headers.get('location'), /from=proactive/);
  const recruiter = await connect(base, 'proactive');
  const coldSearchPage = await fetch(`${base}/hh/proactive?vacancy_id=vac_demo_001`, {
    headers: { cookie: recruiter.cookie },
  });
  assert.equal(coldSearchPage.status, 200, 'the existing synthetic recruiting site remains available');
  assert.match(await coldSearchPage.text(), /candidate-report\?vacancy_id=vac_demo_001&amp;candidate_id=candidate_search_demo_001/);
  const schedule = await fetch(`${base}/api/hh/proactive/vacancy-state`, { method: 'POST',
    headers: { cookie: recruiter.cookie, origin: publicOrigin, 'x-csrf-token': recruiter.csrfToken,
      'content-type': 'application/json' },
    body: JSON.stringify({ vacancy_id: 'vac_demo_001', action: 'enable', interval_hours: 24 }),
  });
  assert.equal(schedule.status, 200);
  const scheduledTick = await fetch(`${base}/__sandbox/tick?vacancy_id=vac_demo_001`, {
    headers: { cookie: recruiter.cookie },
  });
  assert.equal(scheduledTick.status, 200);
  assert.equal((await scheduledTick.json()).outcome, 'synthetic_tick');
  const search = await fetch(`${base}/api/hh/proactive/search`, { method: 'POST',
    headers: { cookie: recruiter.cookie, origin: publicOrigin, 'x-csrf-token': recruiter.csrfToken,
      'content-type': 'application/json', 'Idempotency-Key': 'sandbox-search-001' },
    body: JSON.stringify({ vacancy_id: 'vac_demo_001' }),
  });
  assert.equal(search.status, 200, await search.clone().text());
  const candidates = await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=vac_demo_001`, {
    headers: { cookie: recruiter.cookie },
  });
  assert.equal(candidates.status, 200);
  assert.ok((await candidates.json()).candidates.some(candidate => candidate.candidateRef === sandboxReportFixture.candidateId),
    'the morning feed includes the same synthetic candidate as the report source');

  const entry = await fetch(`${base}/hh/candidate-report?vacancy_id=${sandboxReportFixture.vacancyId}&candidate_id=${sandboxReportFixture.candidateId}`, { redirect: 'manual' });
  assert.equal(entry.status, 303);
  assert.match(entry.headers.get('location'), /from=report/);
  const owner = await connect(base);
  const page = await fetch(`${base}/hh/candidate-report?vacancy_id=${sandboxReportFixture.vacancyId}&candidate_id=${sandboxReportFixture.candidateId}`, {
    headers: { cookie: owner.cookie },
  });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Черновик отчёта кандидата/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const sourceUrl = new URL('/api/v1/ui/accepted-report-client-source', base);
  sourceUrl.searchParams.set('candidateId', sandboxReportFixture.candidateId);
  sourceUrl.searchParams.set('vacancyId', sandboxReportFixture.vacancyId);
  const sourceResponse = await fetch(sourceUrl, { headers: { cookie: owner.cookie } });
  assert.equal(sourceResponse.status, 200);
  const source = await sourceResponse.json();
  assert.equal(source.clientDraftFields.candidateName, 'Синтетический кандидат');
  assert.equal(JSON.stringify(source).includes('@'), false);

  const csrfHeaders = { cookie: owner.cookie, origin: publicOrigin,
    'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' };
  const unauthorized = await fetch(`${base}/api/v1/ui/accepted-report-drafts`, {
    method: 'POST', headers: { ...csrfHeaders, 'x-csrf-token': 'wrong' },
    body: JSON.stringify({ candidateId: sandboxReportFixture.candidateId,
      vacancyId: sandboxReportFixture.vacancyId, expectedSourceRevision: source.sourceRevision }),
  });
  assert.equal(unauthorized.status, 401, 'the actual BFF rejects a wrong CSRF token');

  const createdResponse = await fetch(`${base}/api/v1/ui/accepted-report-drafts`, {
    method: 'POST', headers: { ...csrfHeaders, 'Idempotency-Key': 'sandbox-report-create-001' },
    body: JSON.stringify({ candidateId: sandboxReportFixture.candidateId,
      vacancyId: sandboxReportFixture.vacancyId, expectedSourceRevision: source.sourceRevision,
      expectedPolicyRevision: 0 }),
  });
  assert.equal(createdResponse.status, 201);
  const draft = await createdResponse.json();
  const previewResponse = await fetch(`${base}/api/v1/ui/accepted-report-drafts/${draft.reportRef}/preview`, {
    headers: { cookie: owner.cookie },
  });
  assert.equal(previewResponse.status, 200);
  assert.match((await previewResponse.json()).html, /Синтетический кандидат/);

  const review = await fetch(`${base}/api/v1/ui/accepted-report-drafts/${draft.reportRef}/review`, {
    method: 'POST', headers: csrfHeaders,
    body: JSON.stringify({ expectedReportRevision: draft.reportRevision, decision: 'approved' }),
  });
  assert.equal(review.status, 200);
  const approved = await review.json();
  const exportResponse = await fetch(`${base}/api/v1/ui/accepted-report-drafts/${draft.reportRef}/export`, {
    method: 'POST', headers: csrfHeaders,
    body: JSON.stringify({ expectedReportRevision: approved.reportRevision }),
  });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-disposition'), /^attachment; filename="candidate-report-report_[a-f0-9]{32}\.html"$/);
  assert.match(exportResponse.headers.get('cache-control'), /private, no-store/);
  assert.match(await exportResponse.text(), /Синтетический кандидат/);

  const other = await connect(base);
  const foreignRead = await fetch(`${base}/api/v1/ui/accepted-report-drafts/${draft.reportRef}`, {
    headers: { cookie: other.cookie },
  });
  assert.equal(foreignRead.status, 404, 'another synthetic sandbox profile cannot read the report');
  const dbInfo = await stat(state.databasePath);
  assert.equal(dbInfo.mode & 0o077, 0, 'the encrypted draft database is private to the local owner');
});
