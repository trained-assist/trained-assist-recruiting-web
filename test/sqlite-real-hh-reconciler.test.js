import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { intervalPlan, nextOccurrenceAfter } from '../src/cold-search-schedules.js';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { hhJobIdForOccurrence } from '../src/r03-durable-hh-worker.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState, REAL_HH_RESULT_VERSION } from '../src/sqlite-real-hh-candidate-state.js';
import { SqliteRealHhReconciler } from '../src/sqlite-real-hh-reconciler.js';

const profileId = 'profile_synthetic_001';
const vacancyId = 'vacancy_synthetic_001';
const operator = { id: 'operator_synthetic_001', scopes: ['recruiting.coldSearch.reconcile'], profileIds: [profileId] };
const owned = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
const authorized = (principal, profile) => principal.scopes?.includes('recruiting.coldSearch.reconcile') && principal.profileIds?.includes(profile);
const candidate = id => mapHhResumeCandidate({ id, title: 'Синтетический инженер', first_name: 'Вымышленное', last_name: 'Имя',
  area: { name: 'Вымышленный регион' }, total_experience: { months: 48 },
  experience: [{ position: 'синтетический инженер', company: 'Вымышленное бюро' }] },
{ filters: { min_experience_years: 0 }, required: [{ name: 'синтетический инженер', weight: 2 }] }, vacancyId).candidate;

function fixture(t, { snapshot = true, onStage = () => {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'real-hh-reconcile-'));
  const filename = join(directory, 'private.sqlite');
  const opened = [];
  t.after(() => { for (const store of opened) if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const schedules = new SqliteColdSearchScheduleRepository(filename);
  const state = new SqliteRealHhCandidateState({ filename, isVacancyOwned: owned });
  opened.push(schedules, state);
  const initial = '2026-10-06T06:00:00.000Z';
  const schedulePlan = intervalPlan(24, vacancyId);
  const due = nextOccurrenceAfter(schedulePlan, initial);
  schedules.upsertSchedule({ scheduleId: 'schedule_synthetic_001', legacyJobId: 'legacy_synthetic_001',
    profileId, vacancyId, enabled: true, plan: schedulePlan, nextRunAt: due, leaseOwner: null,
    leaseUntil: null, blockedByUnknownOccurrenceId: null });
  const [claimed] = schedules.claimDueOccurrences({ now: due, workerId: 'worker_synthetic_001',
    leaseUntil: new Date(Date.parse(due) + 300_000).toISOString() });
  const occurrence = claimed.occurrence;
  const jobId = hhJobIdForOccurrence(occurrence.occurrenceId);
  const searchedAt = new Date(Date.parse(due) + 1000).toISOString();
  const criteriaRevision = 'criteria_synthetic_r1';
  const sourceRevision = 'hh-search-synthetic-r1';
  const result = snapshot ? state.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION, profileId, vacancyId, jobId,
    searchedAt, criteriaRevision, sourceRevision, source: 'scheduled', totalCollected: 1,
    candidates: [candidate('inventedresume001')] }) : null;
  schedules.finishOccurrence(occurrence.occurrenceId, 'worker_synthetic_001', {
    status: 'outcome_unknown', errorCode: 'search_outcome_unknown', criteriaRevision, jobId },
  new Date(Date.parse(due) + 2000).toISOString());
  const command = { operator, profileId, vacancyId, occurrenceId: occurrence.occurrenceId, jobId,
    operationId: 'reconcile_synthetic_001', expectedCriteriaRevision: criteriaRevision,
    expectedSourceRevision: sourceRevision, expectedResultRevision: result?.resultRevision ?? '0'.repeat(24),
    reasonCode: 'operator_verified' };
  const makeReconciler = options => { const instance = new SqliteRealHhReconciler({ filename, isOperatorAuthorized: authorized,
    isVacancyOwned: owned, clock: () => new Date(new Date(Date.parse(due) + 3600_000)), onStage, ...options });
    opened.push(instance.state); return instance; };
  return { filename, schedules, state, occurrence, result, command, makeReconciler };
}

test('offline source has no fetch, provider dispatch or Agent Run call', () => {
  const source = readFileSync(new URL('../src/sqlite-real-hh-reconciler.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:https?:\/\/|fetch\(|transport\.search|search\.run\(|launchAgentRun|runAgent|spawnAgent)/i);
});

test('exact committed snapshot resolves unknown and emits idempotent audit receipt', t => {
  const f = fixture(t);
  const reconciler = f.makeReconciler();
  const first = reconciler.reconcile(f.command);
  assert.equal(first.kind, 'reconciled');
  assert.equal(first.receipt.materialized, false);
  assert.equal(first.receipt.searchedAt, f.result.searchedAt);
  const schema = JSON.parse(readFileSync(new URL('../contracts/v1-real-hh-reconciliation-receipt.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(first.receipt), true, JSON.stringify(validate.errors));
  assert.equal(f.schedules.getOccurrence(f.occurrence.occurrenceId).status, 'succeeded');
  assert.equal(f.schedules.getSchedule(f.occurrence.scheduleId).blockedByUnknownOccurrenceId, null);
  assert.equal(f.state.seenTotal(profileId, vacancyId), 1);
  const reopened = f.makeReconciler();
  assert.deepEqual(reopened.reconcile(f.command), { kind: 'replayed', receipt: first.receipt });
  assert.equal(reopened.reconcile({ ...f.command, operationId: 'reconcile_synthetic_002' }).kind, 'occurrence_already_reconciled');
});

test('cross-scope, wrong job and each revision fail closed; absent snapshot stays blocked', t => {
  const f = fixture(t);
  const reconciler = f.makeReconciler();
  const attempts = [
    [{ ...f.command, operator: { ...operator, profileIds: [] } }, 'denied'],
    [{ ...f.command, profileId: 'profile_synthetic_other' }, 'denied'],
    [{ ...f.command, vacancyId: 'vacancy_synthetic_other' }, 'denied'],
    [{ ...f.command, jobId: 'hh_occurrence_wrong' }, 'binding_conflict'],
    [{ ...f.command, expectedCriteriaRevision: 'criteria_synthetic_wrong' }, 'binding_conflict'],
    [{ ...f.command, expectedSourceRevision: 'hh-search-synthetic-wrong' }, 'snapshot_binding_conflict'],
    [{ ...f.command, expectedResultRevision: '0'.repeat(24) }, 'result_revision_conflict']
  ];
  for (const [command, kind] of attempts) assert.equal(reconciler.reconcile(command).kind, kind);
  assert.equal(f.schedules.getOccurrence(f.occurrence.occurrenceId).status, 'outcome_unknown');
  const absent = fixture(t, { snapshot: false });
  assert.equal(absent.makeReconciler().reconcile(absent.command).kind, 'snapshot_not_found');
  assert.equal(absent.schedules.getSchedule(absent.occurrence.scheduleId).blockedByUnknownOccurrenceId, absent.occurrence.occurrenceId);
});

test('receipt-stage exception rolls back occurrence and schedule while retaining preexisting snapshot', t => {
  const f = fixture(t);
  const failing = f.makeReconciler({ onStage: stage => { if (stage === 'audit_receipt') throw new Error('invented_receipt_crash'); } });
  assert.throws(() => failing.reconcile(f.command), /invented_receipt_crash/);
  assert.equal(f.schedules.getOccurrence(f.occurrence.occurrenceId).status, 'outcome_unknown');
  assert.equal(f.schedules.getSchedule(f.occurrence.scheduleId).blockedByUnknownOccurrenceId, f.occurrence.occurrenceId);
  assert.deepEqual(f.state.latestSnapshot(profileId, vacancyId), f.result);
  assert.equal(f.makeReconciler().reconcile(f.command).kind, 'reconciled');
});

test('reconciling an older scheduled snapshot does not replace newer manual freshness', t => {
  const f = fixture(t);
  const later = f.state.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION, profileId, vacancyId,
    jobId: 'manual_synthetic_001', searchedAt: new Date(Date.parse(f.result.searchedAt) + 3600_000).toISOString(),
    criteriaRevision: 'criteria_synthetic_r2', sourceRevision: 'hh-search-synthetic-r2', source: 'manual',
    totalCollected: 1, candidates: [candidate('inventedresume002')] });
  assert.equal(f.makeReconciler().reconcile(f.command).kind, 'reconciled');
  assert.equal(f.state.latestSnapshot(profileId, vacancyId).jobId, later.jobId);
  assert.equal(f.state.seenTotal(profileId, vacancyId), 2);
});
