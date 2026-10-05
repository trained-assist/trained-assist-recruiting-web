import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { SqliteRealHhCandidateState, REAL_HH_RESULT_VERSION } from '../src/sqlite-real-hh-candidate-state.js';
import { createOfflineHhColdSearch } from '../src/hh-cold-search-offline.js';
import { SqliteRealHhManualRuns } from '../src/sqlite-real-hh-manual-runs.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { createDurableHhOccurrenceWorker } from '../src/r03-durable-hh-worker.js';
import { intervalPlan, nextOccurrenceAfter } from '../src/cold-search-schedules.js';

const profileId = 'profile_synthetic_001';
const vacancyId = 'vacancy_synthetic_001';
const context = { profileId, scopes: ['recruiting.candidateSearch'] };
const request = { vacancyId, criteriaRevision: 'criteria_synthetic_r1', queryRevision: 'query_synthetic_r1' };
const atsConfig = { filters: { min_experience_years: 0 }, required: [{ name: 'синтетический инженер', weight: 2 }] };
const plan = { profileId, vacancyId, criteriaRevision: request.criteriaRevision,
  queryCache: { revision: request.queryRevision, queries: ['invented query'] }, atsConfig, area: null };
const candidate = id => mapHhResumeCandidate({ id, title: 'Синтетический инженер', first_name: 'Вымышленное', last_name: 'Имя',
  area: { name: 'Вымышленный регион' }, total_experience: { months: 48 },
  experience: [{ position: 'синтетический инженер', company: 'Вымышленное бюро' }] }, atsConfig, vacancyId).candidate;

function fixture(t, { searchOverride = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'real-hh-manual-'));
  const filename = join(directory, 'private.sqlite');
  const opened = [];
  t.after(() => { for (const store of opened) if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const state = new SqliteRealHhCandidateState({ filename,
    isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId });
  opened.push(state);
  let now = '2026-10-06T06:00:00.000Z';
  let calls = 0;
  const clock = () => new Date(now);
  const loadSearchPlan = async () => plan;
  const search = createOfflineHhColdSearch({ loadSearchPlan,
    transport: { search: async () => { calls++; return { profileId, vacancyId, areas: [], items: [{
      id: 'inventedresume001', title: 'Синтетический инженер', first_name: 'Вымышленное', last_name: 'Имя',
      area: { name: 'Вымышленный регион' }, total_experience: { months: 48 },
      experience: [{ position: 'синтетический инженер', company: 'Вымышленное бюро' }]
    }] }; } }, candidateState: state, clock });
  const makeRuns = options => { const store = new SqliteRealHhManualRuns({ filename,
    isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId,
    loadSearchPlan, search: searchOverride ?? search, candidateState: state, clock, ...options });
    opened.push(store); return store; };
  return { filename, state, search, makeRuns, clock, setNow: value => { now = value; }, get calls() { return calls; } };
}

async function until(get, predicate) {
  for (let i = 0; i < 30; i++) {
    const value = get();
    if (predicate(value)) return value;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('run_not_settled');
}

test('manual run persists start/poll, shares real candidate model with scheduled search and separates ATS', async t => {
  const f = fixture(t);
  const schedules = new SqliteColdSearchScheduleRepository(f.filename);
  t.after(() => { if (schedules.db.open) schedules.close(); });
  const schedulePlan = intervalPlan(24, vacancyId);
  const due = nextOccurrenceAfter(schedulePlan, f.clock().toISOString());
  schedules.upsertSchedule({ scheduleId: 'schedule_synthetic_001', legacyJobId: 'legacy_synthetic_001',
    profileId, vacancyId, enabled: true, plan: schedulePlan, nextRunAt: due, leaseOwner: null,
    leaseUntil: null, blockedByUnknownOccurrenceId: null });
  f.setNow(due);
  const scheduled = createDurableHhOccurrenceWorker({ scheduleRepository: schedules, loadSearchPlan: async () => plan,
    search: f.search, candidateState: f.state, clock: f.clock });
  assert.equal((await scheduled.tick('worker_synthetic_001')).completed, 1);
  const runs = f.makeRuns();
  const started = await runs.start(context, 'manual_key_001', request);
  assert.equal(started.kind, 'created');
  assert.equal(started.run.atsRefresh.status, 'not_started');
  const finished = await until(() => runs.get(context, started.run.runId), value => value.run?.status === 'completed');
  const schema = JSON.parse(readFileSync(new URL('../contracts/v1-real-hh-manual-run.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(started.run), true, JSON.stringify(validate.errors));
  assert.equal(validate(finished.run), true, JSON.stringify(validate.errors));
  assert.equal(finished.run.search.status, 'completed');
  assert.equal(finished.run.atsRefresh.status, 'pending');
  assert.equal(finished.run.automaticRetryAllowed, false);
  assert.equal(runs.resultPage(context, started.run.runId).page.items.length, 1);
  assert.equal(f.state.seenTotal(profileId, vacancyId), 1, 'manual and scheduled share seen state');
  assert.equal(f.calls, 2);
  assert.equal((await runs.start(context, 'manual_key_001', request)).kind, 'replay');
  assert.equal((await runs.start(context, 'manual_key_001', { ...request, queryRevision: 'other' })).kind, 'conflict');
  const reopened = f.makeRuns();
  assert.equal(reopened.get(context, started.run.runId).run.status, 'completed');
  const receipts = reopened.listAcceptedManualReceipts(profileId, vacancyId);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0], { status: 'succeeded', profileId, vacancyId,
    jobId: finished.run.resultJobId, sourceRevision: finished.run.search.sourceRevision,
    resultRevision: f.state.resultPage({ profileId, vacancyId, jobId: finished.run.resultJobId }).snapshot.resultRevision,
    resultCount: 1 });
  assert.throws(() => reopened.listAcceptedManualReceipts('other', vacancyId), /manual_receipt_scope_denied/);
  assert.equal((await reopened.start(context, 'manual_key_001', request)).kind, 'replay');
  assert.equal(f.calls, 2);
  assert.equal(reopened.get({ profileId: 'other', scopes: context.scopes }, started.run.runId).kind, 'not_found');
  const durable = reopened.db.prepare('SELECT payload FROM real_hh_manual_run WHERE run_id=?').get(started.run.runId);
  const altered = { ...JSON.parse(durable.payload), resultRevision: '0'.repeat(24) };
  reopened.db.prepare('UPDATE real_hh_manual_run SET payload=? WHERE run_id=?').run(JSON.stringify(altered), started.run.runId);
  assert.deepEqual(reopened.listAcceptedManualReceipts(profileId, vacancyId), [], 'revision mismatch cannot produce acceptance');
});

test('restart/expired lease quarantines pending run and never repeats provider call', async t => {
  let release;
  let calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const searchOverride = { run: async () => { calls++; await held; throw new Error('invented timeout'); } };
  const f = fixture(t, { searchOverride });
  const first = f.makeRuns({ leaseMs: 60_000 });
  const created = await first.start(context, 'manual_key_002', request);
  await until(() => calls, value => value === 1);
  f.state.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION, profileId, vacancyId,
    jobId: created.run.resultJobId, searchedAt: f.clock().toISOString(),
    criteriaRevision: request.criteriaRevision, sourceRevision: 'hh-search-synthetic-r1',
    source: 'manual', totalCollected: 1, candidates: [candidate('inventedresume999')] });
  f.setNow('2026-10-06T06:02:00.000Z');
  const restarted = f.makeRuns({ leaseMs: 60_000 });
  assert.equal(restarted.get(context, created.run.runId).run.status, 'outcome_unknown');
  assert.deepEqual(restarted.listAcceptedManualReceipts(profileId, vacancyId), [], 'a committed snapshot cannot certify an unknown run');
  assert.equal((await restarted.start(context, 'manual_key_002', request)).kind, 'replay');
  assert.equal(calls, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarted.get(context, created.run.runId).run.status, 'outcome_unknown');
  assert.equal(restarted.resultPage(context, created.run.runId).run.status, 'outcome_unknown');
});

test('missing plan and cross-profile request cannot dispatch', async t => {
  const f = fixture(t);
  const runs = f.makeRuns();
  assert.equal((await runs.start({ profileId: 'other', scopes: context.scopes }, 'manual_key_003', request)).kind, 'denied_or_invalid');
  assert.equal((await runs.start(context, 'manual_key_003', { ...request, criteriaRevision: 'wrong' })).kind, 'search_plan_unavailable');
  assert.equal(f.calls, 0);
  assert.equal(runs.get(context, 'manual_unknown').kind, 'unknown');
  assert.equal(runs.get({ profileId, scopes: [] }, 'manual_unknown').kind, 'denied');
});
