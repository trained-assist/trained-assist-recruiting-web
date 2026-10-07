import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createColdSearchScheduleHandler } from '../src/cold-search-schedules.js';
import { SqliteCandidateSearchJobs } from '../src/sqlite-candidate-search-jobs.js';
import { SqliteCandidateStateStore } from '../src/sqlite-candidate-state.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { SqliteColdSearchReconciler } from '../src/sqlite-cold-search-reconciler.js';
import { createCandidateState } from '../src/candidate-state.js';

const profileId = 'profile_demo_001';
const vacancyId = 'vac_demo_001';
const request = { vacancyId, criteriaRevision: 'criteria-search-demo-r1', criteria: { keywords: ['synthetic'], regions: ['region_demo_001'] } };
const item = { candidateRef: 'candidate_search_demo_001', vacancyId, title: 'Synthetic engineer', region: 'Synthetic region', evidenceSummary: 'Synthetic evidence' };
const operator = { id: 'operator_demo_001', profileIds: [profileId], scopes: ['recruiting.coldSearch.reconcile'] };
const digest = value => createHash('sha256').update(value).digest('hex');
const owned = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
const authorized = (principal, profile) => principal.scopes.includes('recruiting.coldSearch.reconcile') && principal.profileIds.includes(profile);

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'recruiting-r03-reconcile-'));
  const filename = join(directory, 'shared.sqlite');
  const opened = [];
  t.after(() => { for (const handle of opened) if (handle.db.open) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  let now = '2026-10-06T00:00:00.000Z';
  let providerCalls = 0;
  const schedules = new SqliteColdSearchScheduleRepository(filename);
  const jobs = new SqliteCandidateSearchJobs({ filename, clock: () => new Date(now), provider: async () => {
    providerCalls++;
    return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [item], nextCursor: null, complete: true };
  } });
  opened.push(schedules, jobs);
  let completedJobId;
  const handler = createColdSearchScheduleHandler({ repository: schedules, clock: () => new Date(now),
    resolveSearchRequest: async () => request,
    executeSearch: async ({ profileId: selectedProfile, idempotencyKey, request: selectedRequest }) => {
      const started = await jobs.start(selectedProfile, idempotencyKey, selectedRequest);
      completedJobId = started.job.jobId;
      throw new Error('synthetic crash after completed job, before candidate state');
    } });
  const enabled = await handler.handle({ action: 'enable', vacancyId, interval_hours: 1 }, { profileId, scopes: ['recruiting.candidateSearch'] });
  now = enabled.schedule.nextRunAt;
  assert.deepEqual(await handler.tick('synthetic-worker'), { claimed: 1, completed: 0, unknown: 1 });
  const occurrence = schedules.listOccurrences(profileId)[0];
  const job = jobs.getRaw(completedJobId);
  assert.equal(job.status, 'completed');
  assert.equal(occurrence.status, 'outcome_unknown');
  const resultRevision = digest(`${job.jobId}|${job.sourceRevision}|${job.items.map(candidate => candidate.candidateRef).join(',')}`).slice(0, 16);
  const command = { operator, profileId, vacancyId, occurrenceId: occurrence.occurrenceId, jobId: job.jobId,
    operationId: 'reconcile_demo_001', expectedCriteriaRevision: job.criteriaRevision,
    expectedSourceRevision: job.sourceRevision, expectedResultRevision: resultRevision, reasonCode: 'state_commit_failed' };
  const openReconciler = options => { const instance = new SqliteColdSearchReconciler({ filename,
    isOperatorAuthorized: authorized, isVacancyOwned: owned,
    clock: () => new Date('2026-10-06T10:00:00.000Z'), ...options }); opened.push(instance.stateStore); return instance; };
  return { filename, schedules, jobs, job, occurrence, command, openReconciler, get providerCalls() { return providerCalls; } };
}

test('offline reconciler source has no provider, Agent Run or network call path', async () => {
  const source = await readFile(new URL('../src/sqlite-cold-search-reconciler.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:https?:\/\/|fetch\(|runPage\(|\.start\(|\.resume\(|launchAgentRun|runAgent|spawnAgent)/i);
});

test('crash window materializes snapshot, resolves unknown occurrence, unblocks schedule and emits durable receipt', async t => {
  const setup = await fixture(t);
  const reconciler = setup.openReconciler();
  const first = reconciler.reconcile(setup.command);
  assert.equal(first.kind, 'reconciled');
  assert.equal(first.receipt.materialized, true);
  assert.equal(first.receipt.jobCompletedAt, setup.job.completedAt);
  assert.equal(first.receipt.command.operatorId, operator.id);
  const schema = JSON.parse(await readFile(new URL('../contracts/v1-cold-search-reconciliation-receipt.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(first.receipt), true, JSON.stringify(validate.errors));
  assert.equal(setup.providerCalls, 1);
  const state = new SqliteCandidateStateStore({ filename: setup.filename });
  t.after(() => { if (state.db.open) state.close(); });
  assert.equal(state.read(profileId).snapshotsByVacancy[vacancyId][0].searchedAt, setup.job.completedAt);
  assert.equal(state.read(profileId).seenByVacancy[vacancyId][item.candidateRef], setup.job.completedAt);
  const occurrence = setup.schedules.getOccurrence(setup.occurrence.occurrenceId);
  assert.equal(occurrence.status, 'succeeded');
  assert.equal(occurrence.reconciliationOperationId, setup.command.operationId);
  assert.equal(setup.schedules.getSchedule(occurrence.scheduleId).blockedByUnknownOccurrenceId, null);
  reconciler.close();
  const reopened = setup.openReconciler();
  assert.deepEqual(reopened.reconcile(setup.command), { kind: 'replayed', receipt: first.receipt });
  assert.equal(reopened.reconcile({ ...setup.command, operationId: 'reconcile_demo_002' }).kind, 'occurrence_already_reconciled');
  assert.equal(setup.providerCalls, 1);
});

test('operator and profile/vacancy/criteria/source/result bindings fail closed without a state write', async t => {
  const setup = await fixture(t);
  const defaultDeny = new SqliteColdSearchReconciler({ filename: setup.filename, isVacancyOwned: owned });
  t.after(() => { if (defaultDeny.db.open) defaultDeny.close(); });
  assert.equal(defaultDeny.reconcile(setup.command).kind, 'denied');
  const reconciler = setup.openReconciler();
  const attempts = [
    [{ ...setup.command, operator: { ...operator, scopes: [] } }, 'denied'],
    [{ ...setup.command, operator: { ...operator, profileIds: [] } }, 'denied'],
    [{ ...setup.command, profileId: 'profile_demo_002' }, 'denied'],
    [{ ...setup.command, vacancyId: 'vac_demo_002' }, 'denied'],
    [{ ...setup.command, expectedCriteriaRevision: 'criteria-search-demo-r2' }, 'binding_conflict'],
    [{ ...setup.command, expectedSourceRevision: 'cold-search-provider-demo-r2' }, 'binding_conflict'],
    [{ ...setup.command, expectedResultRevision: '0000000000000000' }, 'result_revision_conflict'],
    [{ ...setup.command, jobId: 'search_demo_000000000000' }, 'job_binding_conflict']
  ];
  for (const [command, kind] of attempts) assert.equal(reconciler.reconcile(command).kind, kind);
  assert.equal(setup.schedules.getOccurrence(setup.occurrence.occurrenceId).status, 'outcome_unknown');
  const state = new SqliteCandidateStateStore({ filename: setup.filename });
  t.after(() => { if (state.db.open) state.close(); });
  assert.deepEqual(state.read(profileId).snapshotsByVacancy, {});
  assert.equal(setup.providerCalls, 1);
});

test('conflicting snapshot blocks reconciliation; audit-stage failure rolls all three writes back', async t => {
  const setup = await fixture(t);
  const state = new SqliteCandidateStateStore({ filename: setup.filename });
  t.after(() => { if (state.db.open) state.close(); });
  const model = createCandidateState({ store: state, isVacancyOwned: owned });
  model.recordSearch({ profileId, vacancyId, jobId: setup.job.jobId, searchedAt: '2026-10-06T09:00:00.000Z',
    criteriaRevision: setup.job.criteriaRevision, sourceRevision: setup.job.sourceRevision, source: 'scheduled',
    candidates: setup.job.items, totalCollected: setup.job.items.length });
  const reconciler = setup.openReconciler();
  assert.equal(reconciler.reconcile(setup.command).kind, 'snapshot_conflict');
  assert.equal(setup.schedules.getOccurrence(setup.occurrence.occurrenceId).status, 'outcome_unknown');
  // Use another independent fixture to prove outer BEGIN IMMEDIATE rolls back
  // candidate state, occurrence update and receipt together.
  const rollback = await fixture(t);
  const failing = rollback.openReconciler({ onStage: stage => { if (stage === 'audit_receipt') throw new Error('simulated receipt failure'); } });
  assert.throws(() => failing.reconcile(rollback.command), /simulated receipt failure/);
  const after = new SqliteCandidateStateStore({ filename: rollback.filename });
  t.after(() => { if (after.db.open) after.close(); });
  assert.deepEqual(after.read(profileId).snapshotsByVacancy, {});
  assert.equal(rollback.schedules.getOccurrence(rollback.occurrence.occurrenceId).status, 'outcome_unknown');
  assert.equal(rollback.schedules.getSchedule(rollback.occurrence.scheduleId).blockedByUnknownOccurrenceId, rollback.occurrence.occurrenceId);
  const recovered = rollback.openReconciler();
  assert.equal(recovered.reconcile(rollback.command).kind, 'reconciled');
  assert.equal(rollback.providerCalls, 1);
});

test('an already matching snapshot is verified, not duplicated, before resolving the occurrence', async t => {
  const setup = await fixture(t);
  const state = new SqliteCandidateStateStore({ filename: setup.filename });
  t.after(() => { if (state.db.open) state.close(); });
  const model = createCandidateState({ store: state, isVacancyOwned: owned });
  model.recordSearch({ profileId, vacancyId, jobId: setup.job.jobId, searchedAt: setup.job.completedAt,
    criteriaRevision: setup.job.criteriaRevision, sourceRevision: setup.job.sourceRevision, source: 'scheduled',
    candidates: setup.job.items, totalCollected: setup.job.items.length });
  const reconciler = setup.openReconciler();
  const outcome = reconciler.reconcile(setup.command);
  assert.equal(outcome.kind, 'reconciled');
  assert.equal(outcome.receipt.materialized, false);
  assert.equal(state.read(profileId).snapshotsByVacancy[vacancyId].length, 1);
  assert.equal(setup.providerCalls, 1);
});

test('reconciling an older scheduled run cannot replace newer manual freshness', async t => {
  const setup = await fixture(t);
  const state = new SqliteCandidateStateStore({ filename: setup.filename });
  t.after(() => { if (state.db.open) state.close(); });
  const model = createCandidateState({ store: state, isVacancyOwned: owned });
  const laterAt = '2026-10-06T11:00:00.000Z';
  model.recordSearch({ profileId, vacancyId, jobId: 'search_demo_later', searchedAt: laterAt,
    criteriaRevision: setup.job.criteriaRevision, sourceRevision: setup.job.sourceRevision, source: 'manual',
    candidates: [{ ...item, candidateRef: 'candidate_search_demo_002' }], totalCollected: 1 });
  assert.equal(model.latestSnapshot(profileId, vacancyId).source, 'manual');
  const reconciler = setup.openReconciler();
  assert.equal(reconciler.reconcile(setup.command).kind, 'reconciled');
  assert.equal(model.latestSnapshot(profileId, vacancyId).jobId, 'search_demo_later');
  assert.equal(model.latestSnapshot(profileId, vacancyId).searchedAt, laterAt);
  assert.equal(model.candidates(profileId, vacancyId).length, 2);
  state.close();
  const restarted = new SqliteCandidateStateStore({ filename: setup.filename });
  t.after(() => { if (restarted.db.open) restarted.close(); });
  const reopened = createCandidateState({ store: restarted, isVacancyOwned: owned });
  assert.equal(reopened.latestSnapshot(profileId, vacancyId).jobId, 'search_demo_later');
});

test('equal search timestamps choose a stable job ID across append order and restart', async t => {
  const setup = await fixture(t);
  const state = new SqliteCandidateStateStore({ filename: setup.filename });
  t.after(() => { if (state.db.open) state.close(); });
  const model = createCandidateState({ store: state, isVacancyOwned: owned });
  const at = '2026-10-06T11:00:00.000Z';
  for (const [jobId, candidateRef] of [['search_demo_z', 'candidate_search_demo_002'], ['search_demo_a', 'candidate_search_demo_003']]) {
    model.recordSearch({ profileId, vacancyId, jobId, searchedAt: at,
      criteriaRevision: setup.job.criteriaRevision, sourceRevision: setup.job.sourceRevision, source: 'manual',
      candidates: [{ ...item, candidateRef }], totalCollected: 1 });
  }
  assert.equal(model.latestSnapshot(profileId, vacancyId).jobId, 'search_demo_z');
  state.close();
  const restarted = new SqliteCandidateStateStore({ filename: setup.filename });
  t.after(() => { if (restarted.db.open) restarted.close(); });
  assert.equal(createCandidateState({ store: restarted, isVacancyOwned: owned }).latestSnapshot(profileId, vacancyId).jobId, 'search_demo_z');
});
