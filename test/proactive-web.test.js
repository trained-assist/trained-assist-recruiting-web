import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecruitingServer } from '../src/server.js';
import { syntheticColdSearchProvider } from '../src/candidate-search-jobs.js';

const vacancyId = 'vac_demo_001';
const request = { vacancyId, criteriaRevision: 'criteria-search-demo-r1', criteria: { keywords: ['synthetic engineer'], regions: ['region_demo_001'] } };

test('morning page, schedule API and manual search share profile-owned synthetic results', async () => {
  let current = new Date('2026-10-06T00:00:00.000Z');
  let criteriaRevision = request.criteriaRevision;
  let providerCalls = 0;
  let failSecondPage = false;
  const server = createRecruitingServer({
    resolveTrustedProfileContext: req => req.headers['x-test-principal'] ? { profileId: req.headers['x-test-principal'], scopes: req.headers['x-test-scope'] === 'deny' ? [] : ['recruiting.candidateSearch'] } : null,
    resolveCurrentSearchCriteriaRevision: () => criteriaRevision,
    resolveScheduledSearchRequest: async (profileId, selectedVacancy) => profileId === 'profile_demo_001' && selectedVacancy === vacancyId ? { ...request, criteriaRevision } : null,
    candidateSearchProvider: async input => { providerCalls++; return failSecondPage && input.cursor === 'fixture-page-2' ? { kind: 'error', code: 'provider_unavailable', retryable: false } : syntheticColdSearchProvider(input); },
    scheduleClock: () => new Date(current)
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'X-Test-Principal': 'profile_demo_001' };
  const get = path => fetch(`${base}${path}`, { headers });
  const post = (path, body, extraHeaders = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=${vacancyId}`)).status, 401);
    assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=${vacancyId}`, { headers: { 'X-Test-Principal': 'profile_demo_002' } })).status, 404);
    assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=${vacancyId}`, { headers: { ...headers, 'X-Test-Scope': 'deny' } })).status, 403);
    const page = await get(`/hh/proactive?vacancy_id=${vacancyId}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await page.text(), /Fresh candidates/);
    const script = await get('/hh/proactive/app.js');
    assert.equal(script.status, 200);
    assert.match(await script.text(), /candidates\?vacancy_id=/);
    const before = await (await get(`/api/hh/proactive/candidates?vacancy_id=${vacancyId}`)).json();
    assert.deepEqual([before.status, before.total, before.candidates.length], ['never_run', 0, 0]);

    const enabledResponse = await post('/api/hh/proactive/vacancy-state', { vacancy_id: vacancyId, action: 'enable', interval_hours: 1 });
    assert.equal(enabledResponse.status, 200);
    const enabled = await enabledResponse.json();
    assert.equal(enabled.schedule.vacancyId, vacancyId);
    assert.equal(enabled.schedule.timezone, 'Europe/Moscow');
    assert.equal((await (await get(`/api/hh/proactive/schedule?vacancy_id=${vacancyId}`)).json()).schedules.length, 1);
    current = new Date(enabled.schedule.nextRunAt);
    assert.deepEqual(await server.coldSearchSchedules.tick('synthetic-minute-worker'), { claimed: 1, completed: 1, unknown: 0 });
    const scheduled = await (await get(`/api/hh/proactive/candidates?vacancy_id=${vacancyId}`)).json();
    assert.deepEqual([scheduled.source, scheduled.status, scheduled.total], ['scheduled', 'completed', 3]);
    assert.equal(scheduled.candidates[0].candidateRef, 'candidate_search_demo_001');
    const occurrences = await (await get(`/api/hh/proactive/occurrences?vacancy_id=${vacancyId}`)).json();
    assert.equal(occurrences.occurrences.length, 1);
    assert.equal(occurrences.occurrences[0].status, 'succeeded');
    assert.equal((await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=${vacancyId}`, { headers: { 'X-Test-Principal': 'profile_demo_002' } })).status, 404);

    current = new Date(current.getTime() + 60_000);
    const scheduledJobId = occurrences.occurrences[0].jobId;
    const callsBeforeCollision = providerCalls;
    const collision = await (await post('/api/hh/proactive/search', { vacancy_id: vacancyId }, { 'Idempotency-Key': `schedule:${occurrences.occurrences[0].occurrenceId}` })).json();
    assert.notEqual(collision.jobId, scheduledJobId, 'manual key cannot replay a scheduled job');
    assert.equal(collision.replayed, false);
    assert.equal(providerCalls, callsBeforeCollision + 2, 'manual collision still runs both provider pages');
    current = new Date(current.getTime() + 60_000);
    const key = 'manual-key-001';
    const manualResponse = await post('/api/hh/proactive/search', { vacancy_id: vacancyId }, { 'Idempotency-Key': key });
    assert.equal(manualResponse.status, 200);
    const manual = await manualResponse.json();
    assert.equal(manual.resultCount, 3);
    const afterManual = await (await get(`/api/hh/proactive/candidates?vacancy_id=${vacancyId}`)).json();
    assert.equal(afterManual.source, 'manual');
    assert.equal(afterManual.total, 3);
    assert.equal((await get(`/api/v1/ui/candidate-searches/${manual.jobId}`)).status, 200);
    const calls = providerCalls;
    current = new Date(current.getTime() + 60_000);
    const replay = await (await post('/api/hh/proactive/search', { vacancy_id: vacancyId }, { 'Idempotency-Key': key })).json();
    assert.equal(replay.replayed, true);
    assert.equal(replay.jobId, manual.jobId);
    assert.equal(replay.searchedAt, manual.searchedAt);
    assert.equal(providerCalls, calls, 'same manual operation never calls HH provider twice');
    criteriaRevision = 'criteria-search-demo-r2';
    assert.equal((await post('/api/hh/proactive/search', { vacancy_id: vacancyId }, { 'Idempotency-Key': key })).status, 409, 'same key cannot silently adopt changed criteria');
    assert.equal(providerCalls, calls);
    criteriaRevision = request.criteriaRevision;
    failSecondPage = true;
    assert.equal((await post('/api/hh/proactive/search', { vacancy_id: vacancyId }, { 'Idempotency-Key': 'failed-manual-002' })).status, 503);
    const afterPartial = await (await get(`/api/hh/proactive/candidates?vacancy_id=${vacancyId}`)).json();
    assert.equal(afterPartial.resultRevision, afterManual.resultRevision, 'partial search never replaces the latest completed feed');
    assert.equal((await post('/api/hh/proactive/search', { vacancy_id: vacancyId }, { 'Idempotency-Key': 'bad key' })).status, 400);
    assert.equal((await post('/api/hh/proactive/vacancy-state', { vacancy_id: vacancyId, action: 'star' })).status, 400);
    assert.equal((await post('/api/hh/proactive/vacancy-state', { vacancy_id: vacancyId, action: 'disable' })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('proactive page and API return a typed error when trusted profile lookup fails', async () => {
  const server = createRecruitingServer({
    resolveTrustedProfileContext: async () => { throw new Error('synthetic identity dependency unavailable'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of [`/hh/proactive?vacancy_id=${vacancyId}`, `/api/hh/proactive/candidates?vacancy_id=${vacancyId}`]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'trusted_profile_unavailable' });
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
