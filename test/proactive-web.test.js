import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecruitingServer } from '../src/server.js';
import { syntheticColdSearchProvider } from '../src/candidate-search-jobs.js';
import { createMemoryCandidateStateStore } from '../src/candidate-state.js';

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

test('concurrent manual retries share one finalized job and one search time', async () => {
  let current = new Date('2026-10-06T00:00:00.000Z');
  let providerCalls = 0;
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const server = createRecruitingServer({
    resolveTrustedProfileContext: () => ({ profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] }),
    resolveCurrentSearchCriteriaRevision: () => request.criteriaRevision,
    resolveScheduledSearchRequest: async () => request,
    candidateSearchProvider: async input => {
      providerCalls++;
      if (providerCalls === 1) { enteredResolve(); await release; }
      return syntheticColdSearchProvider(input);
    },
    scheduleClock: () => { const at = new Date(current); current = new Date(current.getTime() + 1_000); return at; }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const submit = () => fetch(`${base}/api/hh/proactive/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'concurrent-manual-001' },
    body: JSON.stringify({ vacancy_id: vacancyId })
  });
  try {
    const first = submit();
    await entered;
    const second = submit();
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseResolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const [firstBody, secondBody] = await Promise.all([a.json(), b.json()]);
    assert.equal(firstBody.jobId, secondBody.jobId);
    assert.equal(firstBody.searchedAt, secondBody.searchedAt, 'one completion timestamp is stored for all joined requests');
    assert.deepEqual([firstBody.replayed, secondBody.replayed], [false, true]);
    assert.equal(providerCalls, 2, 'one two-page provider search runs');
  } finally { releaseResolve(); await new Promise(resolve => server.close(resolve)); }
});

test('scheduled and manual completions share an accumulated profile-owned feed; partial work stays out', async () => {
  const vacancyB = 'vac_demo_002';
  let current = new Date('2026-10-06T00:00:00.000Z');
  let startsA = 0;
  const stateStore = createMemoryCandidateStateStore();
  const server = createRecruitingServer({
    candidateStateStore: stateStore,
    resolveTrustedProfileContext: req => ({ profileId: req.headers['x-test-principal'], scopes: ['recruiting.candidateSearch'] }),
    resolveCurrentSearchCriteriaRevision: () => request.criteriaRevision,
    resolveScheduledSearchRequest: async (_profileId, selectedVacancy) => ({ ...request, vacancyId: selectedVacancy }),
    candidateSearchProvider: async ({ vacancyId: selectedVacancy, cursor }) => {
      if (selectedVacancy === vacancyB) return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [{
        candidateRef: 'candidate_search_demo_001', vacancyId: vacancyB, title: 'Synthetic B candidate', region: 'Synthetic B region', evidenceSummary: 'Synthetic B evidence'
      }], nextCursor: null, complete: true };
      if (cursor === 'unfinished-page') return { kind: 'error', code: 'provider_unavailable', retryable: false };
      startsA++;
      const ref = `candidate_search_demo_${String(startsA).padStart(3, '0')}`;
      return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [{
        candidateRef: ref, vacancyId, title: `Synthetic candidate ${startsA}`, region: `Synthetic region ${startsA}`, evidenceSummary: `Synthetic evidence ${startsA}`
      }], nextCursor: startsA === 3 ? 'unfinished-page' : null, complete: startsA !== 3 };
    },
    scheduleClock: () => new Date(current)
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headersA = { 'X-Test-Principal': 'profile_demo_001' };
  const headersB = { 'X-Test-Principal': 'profile_demo_002' };
  const read = async (vacancy, headers) => (await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=${vacancy}`, { headers })).json();
  const post = (vacancy, headers, key, path = 'search') => fetch(`${base}/api/hh/proactive/${path}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(path === 'search' ? { vacancy_id: vacancy } : { vacancy_id: vacancy, action: 'enable', interval_hours: 1 })
  });
  try {
    const enabled = await (await post(vacancyId, headersA, 'schedule-enable', 'vacancy-state')).json();
    current = new Date(enabled.schedule.nextRunAt);
    assert.deepEqual(await server.coldSearchSchedules.tick('synthetic-minute-worker'), { claimed: 1, completed: 1, unknown: 0 });
    const first = await read(vacancyId, headersA);
    assert.deepEqual([first.source, first.total, first.latestRunTotal, first.newCount], ['scheduled', 1, 1, 1]);
    assert.equal(first.candidates[0].region, 'Synthetic region 1');
    current = new Date(current.getTime() + 60_000);
    assert.equal((await post(vacancyId, headersA, 'manual-feed-run-002')).status, 200);
    const second = await read(vacancyId, headersA);
    assert.deepEqual([second.source, second.total, second.latestRunTotal, second.newCount], ['manual', 2, 1, 1]);
    assert.deepEqual(second.candidates.map(item => item.candidateRef), ['candidate_search_demo_001', 'candidate_search_demo_002']);
    assert.deepEqual(second.candidates.map(item => [item.inLatestRun, item.isNew]), [[false, false], [true, true]]);
    assert.equal(second.candidates[0].evidenceSummary, 'Synthetic evidence 1', 'older card keeps its UI display fields');
    assert.notEqual(second.resultRevision, first.resultRevision);
    current = new Date(current.getTime() + 60_000);
    assert.equal((await post(vacancyId, headersA, 'manual-partial-003')).status, 503);
    const afterPartial = await read(vacancyId, headersA);
    assert.equal(afterPartial.resultRevision, second.resultRevision);
    assert.equal(afterPartial.total, 2);
    assert.equal(stateStore.read('profile_demo_001').seenByVacancy[vacancyId].candidate_search_demo_003, undefined);
    assert.equal((await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=${vacancyId}`, { headers: headersB })).status, 404);
    assert.equal((await post(vacancyB, headersB, 'manual-other-profile-001')).status, 200);
    const other = await read(vacancyB, headersB);
    assert.equal(other.total, 1);
    assert.equal(other.candidates[0].title, 'Synthetic B candidate');
    assert.equal((await read(vacancyId, headersA)).total, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
