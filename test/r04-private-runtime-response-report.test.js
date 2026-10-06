import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { REAL_HH_RESULT_VERSION, SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { intervalPlan } from '../src/cold-search-schedules.js';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { createPrivateWebRuntime } from '../src/r03-private-web-runtime.js';

const profileId = 'profile_synthetic_owner';
const vacancyId = 'vacancy_synthetic_owned';
const resumeId = 'resumesynthetic001';
const negotiationId = 'negotiationsynthetic001';
const issuer = 'https://cp.example.test';
const origin = 'https://recruiter-assistant.ru';
const now = Date.parse('2026-10-06T09:00:00.000Z');
const token = 'a'.repeat(64);
const scopes = ['recruiting.reports.read', 'recruiting.reports.create', 'recruiting.reports.edit', 'recruiting.reports.review'];
const atsConfig = { vacancy_id: vacancyId, vacancy_title: 'Synthetic Platform Engineer',
  vacancy_context: 'Synthetic vacancy context', filters: { min_experience_years: 0, area: null }, area: null,
  required: [], preferred: [], knockout: [] };
const rawResume = { id: resumeId, title: 'Synthetic Platform Engineer', first_name: 'Синтетический',
  last_name: 'Кандидат', total_experience: { months: 60 }, area: { name: 'Тестовый регион' }, salary: null,
  email: 'private@example.test', alternate_url: 'https://hh.ru/resume/' + resumeId,
  experience: [{ position: 'Platform Engineer', company: 'Synthetic Company', start: '2021', end: null }] };

const response = (value, status = 200) => ({
  status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => value
});
function cookie(responseValue, prefix) {
  const match = responseValue.headers.getSetCookie().find(value => value.startsWith(prefix + '='));
  assert.ok(match, prefix + ' cookie exists');
  return match.split(';')[0];
}

test('private runtime composes accepted HH response source, encrypted draft, BFF and stale-source fence', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r04-private-runtime-')));
  chmodSync(root, 0o700);
  const privateDir = name => { const value = join(root, name); mkdirSync(value, { mode: 0o700 }); return value; };
  const contexts = privateDir('contexts'); const proactive = privateDir('proactive');
  const tokens = privateDir('tokens'); const secrets = privateDir('secrets');
  const stateDb = join(root, 'state.sqlite'); const bffDb = join(root, 'bff.sqlite');
  const reportDb = join(root, 'reports.sqlite'); const configFile = join(root, 'host.json');
  writeFileSync(join(contexts, 'ats_config:' + vacancyId + '.json'),
    JSON.stringify({ value: atsConfig }), { mode: 0o600 });
  writeFileSync(join(tokens, 'hh'), JSON.stringify({ access_token: 'synthetic-hh-token' }), { mode: 0o600 });
  const secretsData = { hh_encryption_key: '1'.repeat(64), hh_client_id: 'synthetic-client',
    hh_client_secret: 'synthetic-client-secret', hh_user_agent: 'synthetic-recruiting/1.0 (support@example.test)',
    ladder_token: 'synthetic-ladder-token', cp_service_key: 'synthetic-cp-service-key-32-characters',
    bff_encryption_key: '2'.repeat(64), report_drafts_encryption_key: '3'.repeat(64) };
  for (const [name, value] of Object.entries(secretsData)) writeFileSync(join(secrets, name), value, { mode: 0o600 });
  writeFileSync(configFile, JSON.stringify({ version: 'r03-private-host-v1', dbPath: stateDb,
    profiles: [{ profileId, contextDirectory: contexts, proactiveDirectory: proactive,
      tokenDirectory: tokens, vacancyIds: [vacancyId] }] }), { mode: 0o600 });

  let currentResume = structuredClone(rawResume);
  let messageCalls = 0; let responseReads = 0; let resumeReads = 0;
  let activeScopes = [...scopes];
  const claims = { active: true, iss: issuer, aud: 'recruiting-web', sub: 'synthetic_actor',
    profileId, sessionId: 'synthetic_session', nbf: now / 1000 - 10, exp: now / 1000 + 600 };
  const fetchImpl = async url => {
    if (url === issuer + '/v1/connected-app-sessions/exchange') return response({ token, expiresAt: now / 1000 + 600 });
    if (url === issuer + '/v1/connected-app-sessions/introspect') return response({ ...claims, scopes: activeScopes });
    if (url === 'https://api.hh.ru/negotiations/' + negotiationId) {
      responseReads++;
      return response({ id: negotiationId, vacancy: { id: vacancyId }, resume: { id: resumeId },
        chat_id: 'chatSynthetic001', state: { id: 'response' }, updated_at: '2026-10-06T08:00:00Z' });
    }
    if (url === 'https://api.hh.ru/resumes/' + resumeId) { resumeReads++; return response(currentResume); }
    if (new URL(String(url)).pathname === '/common/chats/chatSynthetic001/messages') {
      const chatUrl = new URL(String(url));
      assert.equal(chatUrl.searchParams.get('order'), 'prev');
      assert.equal(chatUrl.searchParams.get('limit'), '50');
      messageCalls++;
      return response({ id: 'chatSynthetic001', vacancy_id: vacancyId, has_more: false,
        messages: [{ id: 'messageSynthetic001', creation_time: '2026-10-06T08:30:00Z', type: 'SIMPLE',
          payload: { text: 'synthetic private conversation' }, viewed_by_opponent: false }] });
    }
    if (/\/messages(?:\?|$)/.test(url)) { messageCalls++; throw new Error('unexpected_message_endpoint'); }
    throw new Error('unexpected_provider_url:' + new URL(url).pathname);
  };
  const runtimeOptions = { configFile, secretsDirectory: secrets, fetchImpl, clock: () => new Date(now),
    connectedBffConfig: { issuer, publicOrigin: origin, dbPath: bffDb }, reportDraftDbPath: reportDb };
  let server = createPrivateWebRuntime(runtimeOptions);
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  const candidateState = new SqliteRealHhCandidateState({ filename: stateDb,
    isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId });
  const candidate = mapHhResumeCandidate(rawResume, atsConfig, vacancyId, { bypassMinExperience: true }).candidate;
  const criteriaRevision = 'criteria-' + createHash('sha256').update(JSON.stringify(atsConfig)).digest('hex').slice(0, 24);
  const snapshot = candidateState.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION, profileId, vacancyId,
    jobId: 'jobaccepted0001', source: 'scheduled', searchedAt: '2026-10-06T06:00:00.000Z',
    criteriaRevision, sourceRevision: 'synthetic-source-revision', totalCollected: 1, candidates: [candidate] });
  const pending = candidateState.unassessedLatest({ profileId, vacancyId })[0];
  candidateState.recordAssessment({ profileId, vacancyId, jobId: snapshot.jobId, candidateId: resumeId,
    inputRevision: pending.inputRevision,
    assessment: { atsScore: 8.5, atsTag: 'PASS', knockout: { status: 'passed', criteria: [] } },
    assessedAt: '2026-10-06T06:05:00.000Z' });
  candidateState.close();

  const schedules = new SqliteColdSearchScheduleRepository(stateDb);
  schedules.upsertSchedule({ scheduleId: 'scheduleaccepted001', profileId, vacancyId,
    legacyJobId: 'legacyaccepted001', enabled: true, nextRunAt: '2026-10-06T05:00:00.000Z',
    plan: intervalPlan(24, vacancyId), leaseOwner: null, leaseUntil: null, blockedByUnknownOccurrenceId: null });
  const claim = schedules.claimDueOccurrences({ now: '2026-10-06T09:00:00.000Z',
    workerId: 'seed_worker', leaseUntil: '2026-10-06T10:00:00.000Z' })[0];
  assert.ok(claim);
  assert.equal(schedules.finishOccurrence(claim.occurrence.occurrenceId, 'seed_worker', {
    status: 'succeeded', jobId: snapshot.jobId, criteriaRevision,
    snapshot: { resultRevision: snapshot.resultRevision, sourceRevision: snapshot.sourceRevision,
      resultCount: snapshot.candidateCount },
  }, '2026-10-06T09:01:00.000Z'), true);
  schedules.close();

  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const entry = await fetch(base + '/hh/candidate-report?vacancy_id=' + vacancyId +
    '&candidate_id=' + negotiationId + '&source_kind=accepted_hh_response', { redirect: 'manual' });
  assert.equal(entry.status, 303);
  const start = await fetch(base + entry.headers.get('location'), { redirect: 'manual' });
  assert.equal(start.status, 303);
  const pendingCookie = cookie(start, '__Host-recruiting-oauth-pending');
  const authorize = new URL(start.headers.get('location'));
  const callbackUrl = new URL('/auth/connected/callback', base);
  callbackUrl.searchParams.set('code', 'c'.repeat(64));
  callbackUrl.searchParams.set('state', authorize.searchParams.get('state'));
  callbackUrl.searchParams.set('iss', issuer);
  const callback = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie: pendingCookie } });
  assert.equal(callback.status, 303);
  assert.equal(new URL(callback.headers.get('location')).pathname + new URL(callback.headers.get('location')).search,
    '/hh/candidate-report?vacancy_id=' + vacancyId + '&candidate_id=' + negotiationId + '&source_kind=accepted_hh_response');
  const sessionCookie = cookie(callback, '__Host-recruiting-app-session');
  const session = await (await fetch(base + '/auth/connected/session', { headers: { cookie: sessionCookie } })).json();

  const coldSourceUrl = new URL('/api/v1/ui/accepted-report-client-source', base);
  coldSourceUrl.searchParams.set('candidateId', resumeId);
  coldSourceUrl.searchParams.set('vacancyId', vacancyId);
  coldSourceUrl.searchParams.set('sourceKind', 'accepted_cold_search');
  const coldSourceResponse = await fetch(coldSourceUrl, { headers: { cookie: sessionCookie } });
  assert.equal(coldSourceResponse.status, 200);
  const coldSource = await coldSourceResponse.json();
  assert.equal(coldSource.sourceKind, 'accepted_cold_search');
  assert.equal(coldSource.clientDraftFields.candidateName, 'Синтетический Кандидат');
  assert.equal(JSON.stringify(coldSource).includes('private@example.test'), false);
  const coldCreate = await fetch(base + '/api/v1/ui/accepted-report-drafts', { method: 'POST',
    headers: { cookie: sessionCookie, origin, 'x-csrf-token': session.csrfToken,
      'content-type': 'application/json', 'Idempotency-Key': 'runtime-cold-search-report-001' },
    body: JSON.stringify({ candidateId: resumeId, vacancyId, sourceKind: 'accepted_cold_search',
      expectedSourceRevision: coldSource.sourceRevision, expectedPolicyRevision: 0 }) });
  assert.equal(coldCreate.status, 201);
  const coldDraft = await coldCreate.json();
  const coldPreview = await fetch(base + '/api/v1/ui/accepted-report-drafts/' + coldDraft.reportRef + '/preview',
    { headers: { cookie: sessionCookie } });
  assert.equal(coldPreview.status, 200);
  assert.match((await coldPreview.json()).html, /Синтетический Кандидат/);

  const sourceUrl = new URL('/api/v1/ui/accepted-report-client-source', base);
  sourceUrl.searchParams.set('candidateId', negotiationId);
  sourceUrl.searchParams.set('vacancyId', vacancyId);
  sourceUrl.searchParams.set('sourceKind', 'accepted_hh_response');
  const sourceResponse = await fetch(sourceUrl, { headers: { cookie: sessionCookie } });
  assert.equal(sourceResponse.status, 200);
  const source = await sourceResponse.json();
  assert.equal(source.sourceKind, 'accepted_hh_response');
  assert.equal(source.clientDraftFields.candidateName, 'Синтетический Кандидат');
  assert.equal(JSON.stringify(source).includes('private@example.test'), false);
  assert.equal(JSON.stringify(source).includes('internalAssessment'), false);

  const policyUrl = new URL('/api/v1/ui/accepted-report-policy', base);
  policyUrl.searchParams.set('candidateId', negotiationId);
  policyUrl.searchParams.set('vacancyId', vacancyId);
  policyUrl.searchParams.set('sourceKind', 'accepted_hh_response');
  const emptyPolicyResponse = await fetch(policyUrl, { headers: { cookie: sessionCookie } });
  assert.equal(emptyPolicyResponse.status, 200);
  const emptyPolicy = await emptyPolicyResponse.json();
  assert.equal(emptyPolicy.policyRevision, 'policy-r0');
  const forbiddenPhrase = 'synthetic platform engineer';
  const policyWithoutCsrf = await fetch(base + '/api/v1/ui/accepted-report-policy', { method: 'PUT', headers: {
    cookie: sessionCookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ candidateId: negotiationId, vacancyId, sourceKind: 'accepted_hh_response',
      expectedPolicyRevision: 0, policy: { forbiddenPhrases: [forbiddenPhrase] } }) });
  assert.equal(policyWithoutCsrf.status, 401);
  const setPolicy = await fetch(base + '/api/v1/ui/accepted-report-policy', { method: 'PUT', headers: {
    cookie: sessionCookie, origin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ candidateId: negotiationId, vacancyId, sourceKind: 'accepted_hh_response',
      expectedPolicyRevision: 0, policy: { forbiddenPhrases: [forbiddenPhrase] } }) });
  assert.equal(setPolicy.status, 200);
  assert.equal((await setPolicy.json()).policyRevision, 'policy-r1');
  const blockedCreate = await fetch(base + '/api/v1/ui/accepted-report-drafts', { method: 'POST',
    headers: { cookie: sessionCookie, origin, 'x-csrf-token': session.csrfToken,
      'content-type': 'application/json', 'Idempotency-Key': 'runtime-policy-block-001' },
    body: JSON.stringify({ candidateId: negotiationId, vacancyId, sourceKind: 'accepted_hh_response',
      expectedSourceRevision: source.sourceRevision, expectedPolicyRevision: 1 }) });
  assert.equal(blockedCreate.status, 422);
  const blockedBody = await blockedCreate.json();
  assert.equal(blockedBody.error, 'report_policy_violation');
  assert.deepEqual(blockedBody.violations, [
    { fieldPath: 'position', rule: 'forbidden', ruleIndex: 0 },
    { fieldPath: 'vacancyTitle', rule: 'forbidden', ruleIndex: 0 },
  ]);
  assert.equal(JSON.stringify(blockedBody).includes(forbiddenPhrase), false);
  const clearPolicy = await fetch(base + '/api/v1/ui/accepted-report-policy', { method: 'PUT', headers: {
    cookie: sessionCookie, origin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ candidateId: negotiationId, vacancyId, sourceKind: 'accepted_hh_response',
      expectedPolicyRevision: 1, policy: { forbiddenPhrases: [] } }) });
  assert.equal(clearPolicy.status, 200);
  assert.equal((await clearPolicy.json()).policyRevision, 'policy-r2');

  const create = await fetch(base + '/api/v1/ui/accepted-report-drafts', { method: 'POST',
    headers: { cookie: sessionCookie, origin, 'x-csrf-token': session.csrfToken,
      'content-type': 'application/json', 'Idempotency-Key': 'runtime-hh-response-report-001' },
    body: JSON.stringify({ candidateId: negotiationId, vacancyId, sourceKind: 'accepted_hh_response',
      expectedSourceRevision: source.sourceRevision, expectedPolicyRevision: 2 }) });
  assert.equal(create.status, 201);
  const draft = await create.json();
  const preview = await fetch(base + '/api/v1/ui/accepted-report-drafts/' + draft.reportRef + '/preview',
    { headers: { cookie: sessionCookie } });
  assert.equal(preview.status, 200);
  assert.match((await preview.json()).html, /Синтетический Кандидат/);
  assert.equal(statSync(reportDb).mode & 0o777, 0o600);
  assert.equal(messageCalls, 0, 'cold-search and response report creation/preview do not read the conversation');
  assert.ok(responseReads >= 2 && resumeReads >= 2);

  const conversationStart = await fetch(base + '/auth/connected/start?from=conversation&vacancy_id=' +
    vacancyId + '&negotiation_id=' + negotiationId, { redirect: 'manual' });
  assert.equal(conversationStart.status, 303);
  const conversationAuthorize = new URL(conversationStart.headers.get('location'));
  assert.equal(conversationAuthorize.searchParams.get('scope'),
    'recruiting.responses.read recruiting.responses.conversation.open');
  activeScopes = conversationAuthorize.searchParams.get('scope').split(' ');
  const conversationPending = cookie(conversationStart, '__Host-recruiting-oauth-pending');
  const conversationCallbackUrl = new URL('/auth/connected/callback', base);
  conversationCallbackUrl.searchParams.set('code', 'd'.repeat(64));
  conversationCallbackUrl.searchParams.set('state', conversationAuthorize.searchParams.get('state'));
  conversationCallbackUrl.searchParams.set('iss', issuer);
  const conversationCallback = await fetch(conversationCallbackUrl, { redirect: 'manual',
    headers: { cookie: conversationPending } });
  assert.equal(conversationCallback.status, 303);
  assert.equal(new URL(conversationCallback.headers.get('location')).pathname +
    new URL(conversationCallback.headers.get('location')).search,
    '/hh/response-conversation?vacancy_id=' + vacancyId + '&negotiation_id=' + negotiationId);
  const conversationSessionCookie = cookie(conversationCallback, '__Host-recruiting-app-session');
  const conversationSession = await (await fetch(base + '/auth/connected/session',
    { headers: { cookie: conversationSessionCookie } })).json();
  const conversationUrl = base + '/hh/response-conversation?vacancy_id=' + vacancyId +
    '&negotiation_id=' + negotiationId;
  const confirmation = await fetch(conversationUrl, { headers: { cookie: conversationSessionCookie } });
  assert.equal(confirmation.status, 200);
  assert.match(await confirmation.text(), /может отметить отклик просмотренным/);
  assert.equal(messageCalls, 0, 'confirmation page must not prefetch HH messages');
  const deniedWithoutCsrf = await fetch(conversationUrl, { method: 'POST',
    headers: { cookie: conversationSessionCookie, origin } });
  assert.equal(deniedWithoutCsrf.status, 401);
  assert.equal(messageCalls, 0, 'missing CSRF cannot trigger a message read');
  const openedConversation = await fetch(conversationUrl, { method: 'POST', headers: {
    cookie: conversationSessionCookie, origin, 'x-csrf-token': conversationSession.csrfToken } });
  assert.equal(openedConversation.status, 200);
  assert.equal((await openedConversation.json()).messages[0].text, 'synthetic private conversation');
  assert.equal(messageCalls, 1, 'only explicit CSRF-protected POST reaches HH conversation endpoint');

  activeScopes = [...scopes];
  await new Promise(resolve => server.close(resolve));
  server = createPrivateWebRuntime(runtimeOptions);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const restartedBase = 'http://127.0.0.1:' + server.address().port;
  const afterRestart = await fetch(restartedBase + '/api/v1/ui/accepted-report-drafts/' +
    draft.reportRef + '/preview', { headers: { cookie: sessionCookie } });
  assert.equal(afterRestart.status, 200, 'encrypted report and BFF session survive process restart');
  const changedPolicy = await fetch(restartedBase + '/api/v1/ui/accepted-report-policy', { method: 'PUT', headers: {
    cookie: sessionCookie, origin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ candidateId: negotiationId, vacancyId, sourceKind: 'accepted_hh_response',
      expectedPolicyRevision: 2, policy: { forbiddenPhrases: ['confidential'] } }) });
  assert.equal(changedPolicy.status, 200);
  assert.equal((await changedPolicy.json()).policyRevision, 'policy-r3');
  const staleByPolicy = await fetch(restartedBase + '/api/v1/ui/accepted-report-drafts/' +
    draft.reportRef + '/preview', { headers: { cookie: sessionCookie } });
  assert.equal(staleByPolicy.status, 409);
  assert.equal((await staleByPolicy.json()).error, 'stale_report_policy');
  const damagedPolicyDb = new Database(reportDb);
  damagedPolicyDb.exec('DROP TABLE accepted_report_policy');
  damagedPolicyDb.close();
  const policyUnavailable = await fetch(new URL(policyUrl.pathname + policyUrl.search, restartedBase), {
    headers: { cookie: sessionCookie } });
  assert.equal(policyUnavailable.status, 503);
  assert.equal((await policyUnavailable.json()).error, 'report_policy_unavailable');
  const policyWriteUnavailable = await fetch(restartedBase + '/api/v1/ui/accepted-report-policy', { method: 'PUT', headers: {
    cookie: sessionCookie, origin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ candidateId: negotiationId, vacancyId, sourceKind: 'accepted_hh_response',
      expectedPolicyRevision: 3, policy: { forbiddenPhrases: ['confidential'] } }) });
  assert.equal(policyWriteUnavailable.status, 503);
  assert.equal((await policyWriteUnavailable.json()).error, 'report_policy_unavailable');
  assert.equal((await fetch(restartedBase + '/health/ready')).status, 200,
    'policy store failure is contained to report policy operations');
  currentResume = { ...currentResume, title: 'Changed outside the accepted ATS input' };
  const stale = await fetch(restartedBase + '/api/v1/ui/accepted-report-drafts/' +
    draft.reportRef + '/preview', { headers: { cookie: sessionCookie } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'stale_report_source');
  assert.equal(messageCalls, 1, 'restart and report preview never re-read the conversation');
  assert.equal(readFileSync(reportDb, 'utf8').includes('Synthetic'), false,
    'encrypted database bytes do not contain report content');
});
