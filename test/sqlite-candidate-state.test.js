import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCandidateState } from '../src/candidate-state.js';
import { SqliteCandidateStateStore } from '../src/sqlite-candidate-state.js';
import { SqliteCandidateSearchJobs } from '../src/sqlite-candidate-search-jobs.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { createRecruitingServer } from '../src/server.js';

const profileA = 'profile_demo_001';
const profileB = 'profile_demo_002';
const vacancyA = 'vac_demo_001';
const vacancyB = 'vac_demo_002';
const owned = (profile, vacancy) => profile === profileA && [vacancyA, vacancyB].includes(vacancy) || profile === profileB && vacancy === vacancyB;
const item = (ref, vacancyId = vacancyA) => ({ candidateRef: ref, vacancyId, title: 'Synthetic engineer', region: 'Synthetic region', evidenceSummary: 'Synthetic evidence' });
const search = (jobId, candidates, vacancyId = vacancyA, profileId = profileA) => ({ profileId, vacancyId, jobId,
  searchedAt: '2026-10-06T06:00:00.000Z', criteriaRevision: 'criteria-search-demo-r1',
  sourceRevision: 'cold-search-provider-demo-r1', source: 'manual', candidates, totalCollected: candidates.length });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'recruiting-r03-candidates-'));
  const filename = join(directory, 'shared.sqlite');
  const opened = [];
  t.after(() => { for (const store of opened) if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { filename, open: options => { const store = new SqliteCandidateStateStore({ filename, ...options }); opened.push(store); return store; } };
}

test('candidate/seen/snapshot and vacancy overlays survive restart in the same private SQLite file', t => {
  const { filename, open } = fixture(t);
  const first = open();
  const model = createCandidateState({ store: first, isVacancyOwned: owned });
  model.recordSearch(search('search_demo_001', [item('candidate_search_demo_001')]));
  model.setReview({ profileId: profileA, vacancyId: vacancyA, candidateRef: 'candidate_search_demo_001', status: 'starred' });
  first.close();
  const second = open();
  const restarted = createCandidateState({ store: second, isVacancyOwned: owned });
  assert.equal(restarted.latestSnapshot(profileA, vacancyA).jobId, 'search_demo_001');
  assert.equal(restarted.seen(profileA, vacancyA).candidate_search_demo_001, '2026-10-06T06:00:00.000Z');
  assert.equal(restarted.candidates(profileA, vacancyA)[0].review.status, 'starred');
  assert.equal(restarted.candidates(profileA, vacancyA)[0].region, 'Synthetic region');
  assert.throws(() => restarted.candidates(profileB, vacancyA), /vacancy_not_owned/);
  assert.equal(restarted.latestSnapshot(profileB, vacancyB), null);
  assert.equal(statSync(filename).mode & 0o077, 0);
});

test('two open connections and a separate process see serialized updates without losing candidate history', t => {
  const { filename, open } = fixture(t);
  const first = open();
  const second = open();
  const a = createCandidateState({ store: first, isVacancyOwned: owned });
  const b = createCandidateState({ store: second, isVacancyOwned: owned });
  a.recordSearch(search('search_demo_001', [item('candidate_search_demo_001')]));
  b.recordSearch(search('search_demo_002', [item('candidate_search_demo_002')]));
  const code = `import { SqliteCandidateStateStore } from './src/sqlite-candidate-state.js';
import { createCandidateState } from './src/candidate-state.js';
const store = new SqliteCandidateStateStore({ filename: process.argv[1] });
const model = createCandidateState({ store, isVacancyOwned: (profile, vacancy) => profile === 'profile_demo_001' && vacancy === 'vac_demo_001' });
model.recordSearch({ profileId: 'profile_demo_001', vacancyId: 'vac_demo_001', jobId: 'search_demo_003', searchedAt: '2026-10-06T07:00:00.000Z', criteriaRevision: 'criteria-search-demo-r1', sourceRevision: 'cold-search-provider-demo-r1', source: 'manual', totalCollected: 1, candidates: [{ candidateRef: 'candidate_search_demo_003', vacancyId: 'vac_demo_001', title: 'Synthetic child candidate', region: 'Synthetic region', evidenceSummary: 'Synthetic evidence' }] });
store.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, filename], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(a.candidates(profileA, vacancyA).map(candidate => candidate.candidateRef),
    ['candidate_search_demo_001', 'candidate_search_demo_002', 'candidate_search_demo_003']);
  assert.equal(b.latestSnapshot(profileA, vacancyA).jobId, 'search_demo_003');
});

test('pool, seen and snapshot roll back together on a failed stage; replayed job cannot duplicate them', t => {
  let fail = true;
  const { open } = fixture(t);
  const store = open({ onStep: step => { if (fail && step === 'snapshot') throw new Error('simulated disk failure'); } });
  const model = createCandidateState({ store, isVacancyOwned: owned });
  const run = search('search_demo_001', [item('candidate_search_demo_001')]);
  assert.throws(() => model.recordSearch(run), /simulated disk failure/);
  assert.deepEqual(store.read(profileA).candidates, {});
  assert.deepEqual(store.read(profileA).seenByVacancy, {});
  assert.deepEqual(store.read(profileA).snapshotsByVacancy, {});
  fail = false;
  const committed = model.recordSearch(run);
  assert.equal(committed.newCount, 1);
  assert.deepEqual(model.recordSearch({ ...run, searchedAt: '2026-10-06T08:00:00.000Z' }), committed);
  assert.equal(store.read(profileA).snapshotsByVacancy[vacancyA].length, 1);
  assert.throws(() => model.recordSearch({ ...run, candidates: [item('candidate_search_demo_002')] }), /search_job_snapshot_conflict/);
});

test('completed durable job materializes once; page remains readable after web restart', async t => {
  const { filename, open } = fixture(t);
  const stores = [];
  t.after(() => { for (const store of stores) if (store.db.open) store.close(); });
  let providerCalls = 0;
  const provider = async () => { providerCalls++; return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [item('candidate_search_demo_001')], nextCursor: null, complete: true }; };
  const request = { vacancyId: vacancyA, criteriaRevision: 'criteria-search-demo-r1', criteria: { keywords: ['synthetic'], regions: ['region_demo_001'] } };
  const makeServer = () => {
    const jobs = new SqliteCandidateSearchJobs({ filename, provider });
    stores.push(jobs);
    const state = open();
    const server = createRecruitingServer({ candidateSearchJobStore: jobs, candidateStateStore: state,
      resolveTrustedProfileContext: () => ({ profileId: profileA, scopes: ['recruiting.candidateSearch'] }),
      resolveCurrentSearchCriteriaRevision: () => request.criteriaRevision,
      resolveScheduledSearchRequest: async () => request });
    return { server, jobs, state };
  };
  const first = makeServer();
  await new Promise(resolve => first.server.listen(0, '127.0.0.1', resolve));
  const send = (server, method, path) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: method === 'POST' ? { 'Content-Type': 'application/json', 'Idempotency-Key': 'durable-manual-001' } : {},
    ...(method === 'POST' ? { body: JSON.stringify({ vacancy_id: vacancyA }) } : {})
  });
  try {
    assert.equal((await send(first.server, 'POST', '/api/hh/proactive/search')).status, 200);
    const before = await (await send(first.server, 'GET', `/api/hh/proactive/candidates?vacancy_id=${vacancyA}`)).json();
    assert.equal(before.total, 1);
    await new Promise(resolve => first.server.close(resolve));
    first.jobs.close();
    first.state.close();
    const second = makeServer();
    await new Promise(resolve => second.server.listen(0, '127.0.0.1', resolve));
    try {
      const after = await (await send(second.server, 'GET', `/api/hh/proactive/candidates?vacancy_id=${vacancyA}`)).json();
      assert.equal(after.resultRevision, before.resultRevision);
      assert.deepEqual(after.candidates, before.candidates);
      const replay = await (await send(second.server, 'POST', '/api/hh/proactive/search')).json();
      assert.equal(replay.replayed, true);
      assert.equal(replay.searchedAt, before.searchedAt, 'replay uses the persisted job completion time');
      assert.equal(providerCalls, 1);
      assert.equal(second.state.read(profileA).snapshotsByVacancy[vacancyA].length, 1);
    } finally { await new Promise(resolve => second.server.close(resolve)); }
  } finally { if (first.server.listening) await new Promise(resolve => first.server.close(resolve)); }
});

test('candidate-state failure returns typed unknown; same-key retry materializes completed job without provider replay', async t => {
  let fail = true;
  const { filename, open } = fixture(t);
  const state = open({ onStep: step => { if (fail && step === 'snapshot') throw new Error('simulated state commit failure'); } });
  let providerCalls = 0;
  const jobs = new SqliteCandidateSearchJobs({ filename, provider: async () => {
    providerCalls++;
    return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [item('candidate_search_demo_001')], nextCursor: null, complete: true };
  } });
  t.after(() => { if (jobs.db.open) jobs.close(); });
  const request = { vacancyId: vacancyA, criteriaRevision: 'criteria-search-demo-r1', criteria: { keywords: ['synthetic'], regions: ['region_demo_001'] } };
  const server = createRecruitingServer({ candidateSearchJobStore: jobs, candidateStateStore: state,
    resolveTrustedProfileContext: () => ({ profileId: profileA, scopes: ['recruiting.candidateSearch'] }),
    resolveCurrentSearchCriteriaRevision: () => request.criteriaRevision,
    resolveScheduledSearchRequest: async () => request });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(`${base}/api/hh/proactive/search`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'durable-failed-state-001' },
    body: JSON.stringify({ vacancy_id: vacancyA }) });
  try {
    const failed = await post();
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, 'search_outcome_unknown');
    assert.equal(state.read(profileA).snapshotsByVacancy[vacancyA], undefined);
    assert.equal(providerCalls, 1);
    fail = false;
    const recovered = await post();
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).replayed, true);
    assert.equal(providerCalls, 1);
    assert.equal(state.read(profileA).snapshotsByVacancy[vacancyA].length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('scheduled state-commit failure quarantines the occurrence and never redispatches automatically', async t => {
  const { filename, open } = fixture(t);
  const state = open({ onStep: step => { if (step === 'snapshot') throw new Error('simulated candidate-state outage'); } });
  const schedules = new SqliteColdSearchScheduleRepository(filename);
  t.after(() => { if (schedules.db.open) schedules.close(); });
  let calls = 0;
  const jobs = new SqliteCandidateSearchJobs({ filename, provider: async () => {
    calls++;
    return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [item('candidate_search_demo_001')], nextCursor: null, complete: true };
  } });
  t.after(() => { if (jobs.db.open) jobs.close(); });
  const request = { vacancyId: vacancyA, criteriaRevision: 'criteria-search-demo-r1', criteria: { keywords: ['synthetic'], regions: ['region_demo_001'] } };
  let current = new Date('2026-10-06T00:00:00.000Z');
  const server = createRecruitingServer({ candidateSearchJobStore: jobs, candidateStateStore: state,
    candidateSearchScheduleRepository: schedules, scheduleClock: () => new Date(current),
    resolveCurrentSearchCriteriaRevision: () => request.criteriaRevision,
    resolveScheduledSearchRequest: async () => request });
  const principal = { profileId: profileA, scopes: ['recruiting.candidateSearch'] };
  const enabled = await server.coldSearchSchedules.handle({ action: 'enable', vacancyId: vacancyA, interval_hours: 1 }, principal);
  current = new Date(enabled.schedule.nextRunAt);
  assert.deepEqual(await server.coldSearchSchedules.tick('synthetic-worker'), { claimed: 1, completed: 0, unknown: 1 });
  const occurrence = schedules.listOccurrences(profileA)[0];
  assert.equal(occurrence.status, 'outcome_unknown');
  assert.equal(occurrence.errorCode, 'search_outcome_unknown');
  assert.equal(schedules.getSchedule(enabled.schedule.scheduleId).blockedByUnknownOccurrenceId, occurrence.occurrenceId);
  assert.equal(state.read(profileA).snapshotsByVacancy[vacancyA], undefined);
  current = new Date(current.getTime() + 2 * 60 * 60_000);
  assert.equal((await server.coldSearchSchedules.tick('synthetic-worker')).claimed, 0);
  assert.equal(calls, 1);
});

test('SQLite candidate state rejects a shared directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recruiting-r03-state-mode-'));
  try {
    chmodSync(directory, 0o755);
    assert.throws(() => new SqliteCandidateStateStore({ filename: join(directory, 'state.sqlite') }), /owner-only/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
