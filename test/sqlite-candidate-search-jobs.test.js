import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { SqliteCandidateSearchJobs } from '../src/sqlite-candidate-search-jobs.js';
import { createRecruitingServer } from '../src/server.js';

const request = { vacancyId: 'vac_demo_001', criteriaRevision: 'criteria-search-demo-r1', criteria: { keywords: ['synthetic'], regions: ['region_demo_001'] } };
const item = number => ({ candidateRef: `candidate_search_demo_00${number}`, vacancyId: request.vacancyId, title: 'Synthetic engineer', region: 'Synthetic region', evidenceSummary: 'Synthetic evidence' });
const page = (items, nextCursor, complete, sourceRevision = 'cold-search-provider-demo-r1') => ({ kind: 'page', sourceRevision, items, nextCursor, complete });

test('durable search adapter has no Agent Run or network transport dependency', async () => {
  const source = await readFile(new URL('../src/sqlite-candidate-search-jobs.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:launchAgentRun|runAgent|runMcpTool|spawnAgent|codex\s+exec|claude\s+-p)/i);
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(imports.filter(specifier => !specifier.startsWith('node:') && !specifier.startsWith('.')), ['better-sqlite3']);
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'recruiting-r03-jobs-'));
  const filename = join(directory, 'state.sqlite');
  const opened = [];
  t.after(() => { for (const store of opened) if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return options => { const store = new SqliteCandidateSearchJobs({ filename, ...options }); opened.push(store); return store; };
}

test('successful pages, profile idempotency, source revision and result cursors survive restart', async t => {
  const open = fixture(t);
  const calls = [];
  const provider = async ({ cursor, operationId }) => {
    calls.push({ cursor, operationId });
    return cursor === null ? page([item(1), item(2)], 'next-page', false) : page([item(3)], null, true);
  };
  const first = open({ provider });
  const started = await first.start('profile_demo_001', 'key-0001', request);
  assert.equal(started.created, true);
  assert.equal(started.job.status, 'partial');
  const initial = first.results('profile_demo_001', started.job.jobId, { limit: 1, cursor: null });
  assert.equal(initial.items.length, 1);
  assert.ok(initial.nextCursor);
  first.close();
  const second = open({ provider });
  assert.equal(second.get('profile_demo_001', started.job.jobId).resultCount, 2);
  assert.equal(second.get('profile_demo_002', started.job.jobId), null);
  assert.equal((await second.start('profile_demo_001', 'key-0001', request)).created, false);
  assert.equal((await second.start('profile_demo_001', 'key-0001', { ...request, criteriaRevision: 'criteria-search-demo-r2' })).conflict, true);
  assert.equal(calls.length, 1);
  const resumed = await second.resume('profile_demo_001', started.job.jobId);
  assert.equal(resumed.job.status, 'completed');
  assert.equal(resumed.job.resultCount, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, 'next-page');
  assert.equal(second.results('profile_demo_001', started.job.jobId, { limit: 1, cursor: initial.nextCursor }).kind, 'stale_cursor');
  const final = second.results('profile_demo_001', started.job.jobId, { limit: 50, cursor: null });
  assert.equal(final.sourceRevision, 'cold-search-provider-demo-r1');
  assert.deepEqual(final.items.map(row => row.candidateRef), ['candidate_search_demo_001', 'candidate_search_demo_002', 'candidate_search_demo_003']);
  const schema = JSON.parse(await readFile(new URL('../contracts/v1-candidate-search-job.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate(resumed.job), true, JSON.stringify(validate.errors));
});

test('ambiguous in-flight page quarantines after lease expiry and never redispatches on retry', async t => {
  const open = fixture(t);
  let now = new Date('2026-10-06T00:00:00.000Z');
  let calls = 0;
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const provider = async () => { calls++; enter(); await wait; return page([item(1)], null, true); };
  const first = open({ provider, clock: () => new Date(now), dispatchLeaseMs: 60_000 });
  const pending = first.start('profile_demo_001', 'key-ambiguous', request);
  await entered;
  const second = open({ provider, clock: () => new Date(now), dispatchLeaseMs: 60_000 });
  const beforeExpiry = await second.start('profile_demo_001', 'key-ambiguous', request);
  assert.equal(beforeExpiry.created, false);
  assert.equal(beforeExpiry.job.status, 'running');
  assert.equal((await second.resume('profile_demo_001', beforeExpiry.job.jobId)).conflict, true);
  assert.equal(calls, 1);
  now = new Date(now.getTime() + 60_000);
  const unknown = second.get('profile_demo_001', beforeExpiry.job.jobId);
  assert.equal(unknown.status, 'outcome_unknown');
  assert.deepEqual(unknown.providerError, { code: 'search_outcome_unknown', retryable: false });
  release();
  assert.equal((await pending).job.status, 'outcome_unknown', 'late provider response cannot overwrite quarantine');
  assert.equal((await second.start('profile_demo_001', 'key-ambiguous', request)).job.status, 'outcome_unknown');
  assert.equal((await second.resume('profile_demo_001', beforeExpiry.job.jobId)).conflict, true);
  assert.equal(calls, 1);
});

test('provider exception stays unknown after close/reopen; HTTP reads persisted job', async t => {
  const open = fixture(t);
  let calls = 0;
  const first = open({ provider: async () => { calls++; throw new Error('ambiguous provider dispatch'); } });
  const started = await first.start('profile_demo_001', 'key-error', request);
  assert.equal(started.job.status, 'outcome_unknown');
  first.close();
  const second = open({ provider: async () => { calls++; return page([item(1)], null, true); } });
  const server = createRecruitingServer({
    candidateSearchJobStore: second,
    resolveTrustedProfileContext: () => ({ profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] }),
    resolveCurrentSearchCriteriaRevision: () => request.criteriaRevision
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/v1/ui/candidate-searches/${started.job.jobId}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'outcome_unknown');
    const retried = await fetch(`${base}/api/v1/ui/candidate-searches`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-error' }, body: JSON.stringify(request) });
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).status, 'outcome_unknown');
    assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('changed provider source revision cannot append to a persisted partial snapshot', async t => {
  const open = fixture(t);
  const first = open({ provider: async () => page([item(1)], 'next-page', false) });
  const started = await first.start('profile_demo_001', 'key-revision', request);
  assert.equal(started.job.status, 'partial');
  first.close();
  const second = open({ provider: async () => page([item(2)], null, true, 'cold-search-provider-demo-r2') });
  const resumed = await second.resume('profile_demo_001', started.job.jobId);
  assert.equal(resumed.job.status, 'outcome_unknown');
  const results = second.results('profile_demo_001', started.job.jobId, { limit: 50, cursor: null });
  assert.deepEqual(results.items.map(row => row.candidateRef), ['candidate_search_demo_001']);
  assert.equal(results.sourceRevision, 'cold-search-provider-demo-r1');
  assert.equal((await second.resume('profile_demo_001', started.job.jobId)).conflict, true);
});
