import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createRecruitingServer } from '../src/server.js';
import { syntheticColdSearchProvider } from '../src/candidate-search-jobs.js';

const root = new URL('../', import.meta.url);
const vacancyId = 'vac_demo_001';
const request = { vacancyId, criteriaRevision: 'criteria-search-demo-r1', criteria: { keywords: ['synthetic engineer'], regions: ['region_demo_001'] } };
const auth = profile => ({ 'X-Test-Principal': profile });

async function schema() {
  const value = JSON.parse(await readFile(new URL('contracts/v1-manual-search-run.schema.json', root), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(value);
}

function startServer(options = {}) {
  const server = createRecruitingServer({
    resolveTrustedProfileContext: req => ['profile_demo_001', 'profile_demo_002'].includes(req.headers['x-test-principal'])
      ? { profileId: req.headers['x-test-principal'], scopes: ['recruiting.candidateSearch'] }
      : null,
    resolveCurrentSearchCriteriaRevision: (_context, selectedVacancy) => selectedVacancy === vacancyId ? request.criteriaRevision : 'criteria-search-demo-r1',
    ...options
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function eventually(read, predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('run did not reach expected state');
}

test('manual cold search starts asynchronously, polls page progress, and separates completed search from pending ATS refresh', async () => {
  const validate = await schema();
  let providerCalls = 0;
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const server = await startServer({ candidateSearchProvider: async input => {
    providerCalls++;
    if (input.cursor === null) { enteredResolve(); await release; }
    return syntheticColdSearchProvider(input);
  } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, profile = 'profile_demo_001', key = 'manual-run-key-001') => fetch(`${base}/api/v1/ui/manual-search-runs`, {
    method: 'POST', headers: { ...auth(profile), 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body)
  });
  try {
    const response = await post(request);
    assert.equal(response.status, 202);
    const initial = await response.json();
    assert.equal(validate(initial), true, JSON.stringify(validate.errors));
    assert.equal(initial.status, 'running');
    assert.equal(initial.search.phase, 'search');
    assert.equal(initial.search.pagesCompleted, 0);
    assert.deepEqual(initial.atsRefresh, { status: 'not_started', completed: 0, total: null });
    await entered;

    const poll = async () => {
      const result = await fetch(`${base}/api/v1/ui/manual-search-runs/${initial.runId}`, { headers: auth('profile_demo_001') });
      assert.equal(result.status, 200);
      return result.json();
    };
    const inProgress = await poll();
    assert.equal(validate(inProgress), true, JSON.stringify(validate.errors));
    assert.equal(inProgress.search.status, 'running');
    assert.equal(inProgress.search.totalPages, null, 'unknown page count stays indeterminate');

    releaseResolve();
    const completed = await eventually(poll, value => value.status === 'completed');
    assert.equal(validate(completed), true, JSON.stringify(validate.errors));
    assert.equal(completed.search.status, 'completed');
    assert.equal(completed.search.pagesCompleted, 2);
    assert.equal(completed.search.resultCount, 3);
    assert.equal(completed.search.sourceRevision, 'cold-search-provider-demo-r1');
    assert.match(completed.resultJobId, /^search_demo_[a-f0-9]{12}$/);
    assert.deepEqual(completed.atsRefresh, { status: 'pending', completed: 0, total: 3 });
    assert.equal(completed.automaticRetryAllowed, false);
    const results = await fetch(`${base}/api/v1/ui/candidate-searches/${completed.resultJobId}/results`, { headers: auth('profile_demo_001') });
    assert.equal(results.status, 200);
    assert.equal((await results.json()).items.length, 3);
    assert.equal(providerCalls, 2);

    const replay = await post(request);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).runId, initial.runId);
    assert.equal(providerCalls, 2, 'same profile and idempotency key do not dispatch twice');
    assert.equal((await post({ ...request, criteria: { ...request.criteria, keywords: ['different synthetic criteria'] } })).status, 409, 'same key cannot be rebound to another request');
    assert.equal((await fetch(`${base}/api/v1/ui/manual-search-runs/${initial.runId}`, { headers: auth('profile_demo_002') })).status, 404);
    assert.equal((await post({ ...request, vacancyId: 'vac_demo_002' }, 'profile_demo_001', 'manual-run-key-002')).status, 404, 'vacancy must belong to the trusted profile');
  } finally {
    releaseResolve();
    await new Promise(resolve => server.close(resolve));
  }
});

test('unknown provider outcome is terminal, never auto-retried, and a process restart fails closed', async () => {
  let providerCalls = 0;
  let lostRunId;
  const server = await startServer({ candidateSearchProvider: async () => {
    providerCalls++;
    return { kind: 'error', code: 'search_outcome_unknown', retryable: false };
  } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { ...auth('profile_demo_001'), 'Content-Type': 'application/json', 'Idempotency-Key': 'unknown-run-key-001' };
  try {
    const started = await fetch(`${base}/api/v1/ui/manual-search-runs`, { method: 'POST', headers, body: JSON.stringify(request) });
    assert.equal(started.status, 202);
    const initial = await started.json();
    lostRunId = initial.runId;
    const final = await eventually(async () => (await fetch(`${base}/api/v1/ui/manual-search-runs/${initial.runId}`, { headers })).json(), value => value.status === 'outcome_unknown');
    assert.equal(final.search.status, 'outcome_unknown');
    assert.deepEqual(final.search.error, { code: 'search_outcome_unknown' });
    assert.equal(final.automaticRetryAllowed, false);
    const replay = await fetch(`${base}/api/v1/ui/manual-search-runs`, { method: 'POST', headers, body: JSON.stringify(request) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).runId, initial.runId);
    assert.equal(providerCalls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }

  const restarted = await startServer();
  const restartedBase = `http://127.0.0.1:${restarted.address().port}`;
  try {
    const poll = await fetch(`${restartedBase}/api/v1/ui/manual-search-runs/${lostRunId}`, { headers: auth('profile_demo_001') });
    assert.equal(poll.status, 410);
    assert.deepEqual(await poll.json(), { domainApiVersion: 'v1', error: 'run_outcome_unknown', automaticRetryAllowed: false });
  } finally { await new Promise(resolve => restarted.close(resolve)); }
});
