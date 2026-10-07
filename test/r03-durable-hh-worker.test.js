import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intervalPlan, nextOccurrenceAfter } from '../src/cold-search-schedules.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { createOfflineHhColdSearch } from '../src/hh-cold-search-offline.js';
import { createDurableHhOccurrenceWorker } from '../src/r03-durable-hh-worker.js';
import { runAcceptedMorningScoringTick } from '../src/r03-morning-scoring.js';

const profileId = 'profile_synthetic_001';
const vacancyId = 'vacancy_synthetic_001';
const context = { profileId, scopes: ['recruiting.candidateSearch'] };
const atsConfig = { filters: { min_experience_years: 0 }, required: [{ name: 'синтетический инженер', weight: 2 }] };
const plan = { profileId, vacancyId, criteriaRevision: 'criteria_synthetic_r1',
  queryCache: { revision: 'query_synthetic_r1', queries: ['invented query'] }, atsConfig, area: null };
const item = id => ({ id, title: 'Синтетический инженер', first_name: 'Вымышленное', last_name: 'Имя',
  area: { name: 'Вымышленный регион' }, total_experience: { months: 48 },
  experience: [{ position: 'синтетический инженер', company: 'Вымышленное бюро' }] });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'r03-durable-hh-worker-'));
  const filename = join(directory, 'private.sqlite');
  const stores = [];
  t.after(() => { for (const store of stores) if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const openRepository = () => { const store = new SqliteColdSearchScheduleRepository(filename); stores.push(store); return store; };
  const openState = () => { const store = new SqliteRealHhCandidateState({ filename,
    isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId }); stores.push(store); return store; };
  let now = '2026-10-06T06:00:00.000Z';
  let calls = 0;
  const clock = () => new Date(now);
  const repository = openRepository();
  const candidateState = openState();
  const schedulePlan = intervalPlan(24, vacancyId);
  const firstDue = nextOccurrenceAfter(schedulePlan, now);
  repository.upsertSchedule({ scheduleId: 'schedule_synthetic_001', legacyJobId: 'legacy_synthetic_001',
    profileId, vacancyId, enabled: true, plan: schedulePlan, timezone: 'Europe/Moscow',
    jobArguments: { vacancyId }, nextRunAt: firstDue, leaseOwner: null, leaseUntil: null,
    blockedByUnknownOccurrenceId: null });
  const loadSearchPlan = async () => plan;
  const transport = { search: async () => { calls++; return { profileId, vacancyId, areas: [], items: [item('inventedresume001')] }; } };
  const search = createOfflineHhColdSearch({ loadSearchPlan, transport, candidateState, clock });
  const worker = createDurableHhOccurrenceWorker({ scheduleRepository: repository, loadSearchPlan, search, candidateState, clock });
  return { filename, repository, candidateState, openRepository, openState, worker, search,
    setNow: value => { now = value; }, firstDue, get calls() { return calls; } };
}

test('durable occurrence runs injected HH port, survives restart and serves morning result', async t => {
  const f = fixture(t);
  f.setNow(f.firstDue);
  assert.deepEqual(await f.worker.tick('worker_a'), { claimed: 1, completed: 1, rejected: 0, unknown: 0 });
  assert.equal(f.calls, 1);
  assert.equal(f.repository.listOccurrences(profileId)[0].status, 'succeeded');
  const morning = f.worker.morningResults(context, vacancyId);
  assert.equal(morning.freshness, 'latest_completed');
  assert.equal(morning.snapshot.candidateCount, 1);
  assert.equal(morning.items[0].id, 'inventedresume001');
  assert.equal(f.candidateState.seenTotal(profileId, vacancyId), 1);
  const reopened = f.openRepository();
  const reopenedState = f.openState();
  const workerAfterRestart = createDurableHhOccurrenceWorker({ scheduleRepository: reopened,
    loadSearchPlan: async () => plan, search: f.search, candidateState: reopenedState,
    clock: () => new Date(f.firstDue) });
  assert.deepEqual(await workerAfterRestart.tick('worker_b'), { claimed: 0, completed: 0, rejected: 0, unknown: 0 });
  assert.equal(workerAfterRestart.morningResults(context, vacancyId).items.length, 1);
  assert.equal(f.calls, 1);
  assert.equal(workerAfterRestart.morningResults({ profileId: 'other', scopes: context.scopes }, vacancyId).status, 'never_run');
});

test('overlap claims once; expired running work is unknown and never dispatched again', async t => {
  const f = fixture(t);
  f.setNow(f.firstDue);
  const claimed = f.repository.claimDueOccurrences({ now: f.firstDue, workerId: 'crashed_worker',
    leaseUntil: new Date(Date.parse(f.firstDue) + 60_000).toISOString() });
  assert.equal(claimed.length, 1);
  assert.deepEqual(await f.worker.tick('worker_b'), { claimed: 0, completed: 0, rejected: 0, unknown: 0 });
  f.setNow(new Date(Date.parse(f.firstDue) + 120_000).toISOString());
  assert.deepEqual(await f.worker.tick('worker_c'), { claimed: 0, completed: 0, rejected: 0, unknown: 0 });
  assert.equal(f.repository.listOccurrences(profileId)[0].status, 'outcome_unknown');
  assert.equal(f.repository.getSchedule('schedule_synthetic_001').blockedByUnknownOccurrenceId, claimed[0].occurrence.occurrenceId);
  assert.equal(f.calls, 0);
  assert.equal(f.worker.morningResults(context, vacancyId).status, 'never_run');
  assert.equal(f.worker.morningResults(context, vacancyId).freshness, 'latest_run_incomplete');
});

test('provider failure quarantines outcome without fresh snapshot or automatic replay', async t => {
  const f = fixture(t);
  const failed = createDurableHhOccurrenceWorker({ scheduleRepository: f.repository, loadSearchPlan: async () => plan,
    search: { run: async () => { throw new Error('invented HH timeout'); } }, candidateState: f.candidateState,
    clock: () => new Date(f.firstDue) });
  assert.deepEqual(await failed.tick('worker_a'), { claimed: 1, completed: 0, rejected: 0, unknown: 1 });
  assert.deepEqual(await failed.tick('worker_b'), { claimed: 0, completed: 0, rejected: 0, unknown: 0 });
  assert.equal(f.candidateState.latestSnapshot(profileId, vacancyId), null);
  assert.equal(f.repository.listOccurrences(profileId)[0].status, 'outcome_unknown');
});

test('a newer unknown run marks the previous morning result as stale', async t => {
  const f = fixture(t);
  f.setNow(f.firstDue);
  assert.equal((await f.worker.tick('worker_a')).completed, 1);
  const nextDue = f.repository.getSchedule('schedule_synthetic_001').nextRunAt;
  const failed = createDurableHhOccurrenceWorker({ scheduleRepository: f.repository, loadSearchPlan: async () => plan,
    search: { run: async () => { throw new Error('invented failure'); } }, candidateState: f.candidateState,
    clock: () => new Date(nextDue) });
  assert.equal((await failed.tick('worker_b')).unknown, 1);
  const morning = failed.morningResults(context, vacancyId);
  assert.equal(morning.status, 'completed');
  assert.equal(morning.freshness, 'latest_run_incomplete');
  assert.equal(morning.items.length, 1);
});

test('scheduled result is scored after five minutes and read in the morning after restart; newer unknown stays stale', async t => {
  const f = fixture(t);
  f.setNow(f.firstDue);
  assert.equal((await f.worker.tick('worker_a')).completed, 1);
  const initial = f.worker.morningResults(context, vacancyId);
  assert.equal(initial.items[0].atsScore, null);
  let evaluations = 0;
  const scored = await runAcceptedMorningScoringTick({ worker: f.worker, state: f.candidateState,
    trustedContext: context, vacancyId, currentCriteriaRevision: async () => plan.criteriaRevision,
    evaluate: async () => { evaluations++; return { atsScore: 8, atsTag: 'PASS', knockout: { status: 'passed', criteria: [] } }; },
    now: () => new Date(Date.parse(f.firstDue) + 5 * 60_000) });
  assert.equal(scored.status, 'processed');
  assert.equal(scored.written, 1);
  assert.equal(evaluations, 1);
  const reopened = f.openRepository();
  const reopenedState = f.openState();
  const afterRestart = createDurableHhOccurrenceWorker({ scheduleRepository: reopened,
    loadSearchPlan: async () => plan, search: f.search, candidateState: reopenedState,
    clock: () => new Date(f.firstDue) });
  assert.equal(afterRestart.morningResults(context, vacancyId).items[0].atsScore, 8);
  assert.equal(afterRestart.morningResults(context, vacancyId).freshness, 'latest_completed');
  const nextDue = reopened.getSchedule('schedule_synthetic_001').nextRunAt;
  const failed = createDurableHhOccurrenceWorker({ scheduleRepository: reopened, loadSearchPlan: async () => plan,
    search: { run: async () => { throw new Error('invented failure'); } }, candidateState: reopenedState,
    clock: () => new Date(nextDue) });
  assert.equal((await failed.tick('worker_b')).unknown, 1);
  const stale = failed.morningResults(context, vacancyId);
  assert.equal(stale.freshness, 'latest_run_incomplete');
  assert.equal(stale.items[0].atsScore, 8);
  assert.equal(stale.snapshot.jobId, initial.snapshot.jobId);
  assert.throws(() => failed.morningResults({ profileId: 'profile_other', scopes: [] }, vacancyId), /candidate_scope_denied/);
});

test('snapshot committed after expired lease is held for reconciliation, not called success or replayed', async t => {
  const f = fixture(t);
  let now = f.firstDue;
  const search = { run: async input => {
    const result = await f.search.run(input);
    now = new Date(Date.parse(f.firstDue) + 360_000).toISOString();
    return result;
  } };
  const worker = createDurableHhOccurrenceWorker({ scheduleRepository: f.repository, loadSearchPlan: async () => plan,
    search, candidateState: f.candidateState, clock: () => new Date(now), leaseMs: 300_000 });
  assert.deepEqual(await worker.tick('worker_a'), { claimed: 1, completed: 0, rejected: 0, unknown: 1 });
  assert.equal(f.candidateState.latestSnapshot(profileId, vacancyId).candidateCount, 1);
  assert.equal(worker.morningResults(context, vacancyId).status, 'never_run', 'a committed snapshot is not enough to certify the occurrence');
  const held = await runAcceptedMorningScoringTick({ worker, state: f.candidateState, trustedContext: context,
    vacancyId, currentCriteriaRevision: async () => plan.criteriaRevision,
    evaluate: async () => { throw new Error('must not evaluate unknown result'); } });
  assert.equal(held.status, 'held');
  assert.deepEqual(await worker.tick('worker_b'), { claimed: 0, completed: 0, rejected: 0, unknown: 0 });
  assert.equal(f.repository.listOccurrences(profileId)[0].status, 'outcome_unknown');
  assert.equal(f.calls, 1);
});
