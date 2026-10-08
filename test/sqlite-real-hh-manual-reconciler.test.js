import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { REAL_HH_RESULT_VERSION, SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { SqliteRealHhManualRuns } from '../src/sqlite-real-hh-manual-runs.js';
import { SqliteRealHhManualReconciler } from '../src/sqlite-real-hh-manual-reconciler.js';

const profileId = 'profile_synthetic_001';
const vacancyId = 'vacancy_synthetic_001';
const context = { profileId, scopes: ['recruiting.candidateSearch'] };
const operator = { id: 'operator_synthetic_001', scopes: ['recruiting.coldSearch.reconcile'], profileIds: [profileId] };
const owned = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
const authorized = (principal, profile) => principal.scopes?.includes('recruiting.coldSearch.reconcile') && principal.profileIds?.includes(profile);
const atsConfig = { filters: { min_experience_years: 0 }, required: [{ name: 'синтетический инженер', weight: 2 }] };
const criteriaRevision = 'criteria_synthetic_r1';
const sourceRevision = 'hh-search-synthetic-r1';
const plan = { profileId, vacancyId, criteriaRevision,
  queryCache: { revision: 'query_synthetic_r1', queries: ['invented query'] }, atsConfig, area: null };
const candidate = id => mapHhResumeCandidate({ id, title: 'Синтетический инженер', first_name: 'Вымышленное', last_name: 'Имя',
  area: { name: 'Вымышленный регион' }, total_experience: { months: 48 },
  experience: [{ position: 'синтетический инженер', company: 'Вымышленное бюро' }] }, atsConfig, vacancyId).candidate;

async function fixture(t, { snapshot = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'real-hh-manual-reconcile-'));
  const filename = join(directory, 'private.sqlite');
  const opened = [];
  t.after(() => { for (const item of opened) if (item.db.open) item.close(); rmSync(directory, { recursive: true, force: true }); });
  let now = '2026-10-06T06:00:00.000Z';
  let calls = 0;
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const state = new SqliteRealHhCandidateState({ filename, isVacancyOwned: owned });
  const runs = new SqliteRealHhManualRuns({ filename, isVacancyOwned: owned, loadSearchPlan: async () => plan,
    search: { run: async () => { calls++; await hold; return { status: 'completed' }; } },
    candidateState: state, clock: () => new Date(now), leaseMs: 60_000 });
  opened.push(state, runs);
  const started = await runs.start(context, 'manual_key_synthetic_001',
    { vacancyId, criteriaRevision, queryRevision: plan.queryCache.revision });
  assert.equal(started.kind, 'created');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  const runId = started.run.runId;
  const jobId = started.run.resultJobId;
  const result = snapshot ? state.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION, profileId, vacancyId,
    jobId, searchedAt: '2026-10-06T06:00:01.000Z', criteriaRevision, sourceRevision,
    source: 'manual', totalCollected: 1, candidates: [candidate('inventedresume001')] }) : null;
  now = '2026-10-06T06:02:00.000Z';
  assert.equal(runs.get(context, runId).run.status, 'outcome_unknown');
  const command = { operator, profileId, vacancyId, runId, jobId, operationId: 'manual_reconcile_synthetic_001',
    expectedCriteriaRevision: criteriaRevision, expectedSourceRevision: sourceRevision,
    expectedResultRevision: result?.resultRevision ?? '0'.repeat(24), expectedResultCount: 1,
    reasonCode: 'operator_verified' };
  const openReconciler = options => { const instance = new SqliteRealHhManualReconciler({ filename,
    isVacancyOwned: owned, isOperatorAuthorized: authorized, clock: () => new Date(now), ...options });
    opened.push(instance.state); return instance; };
  return { filename, state, runs, command, result, openReconciler,
    get calls() { return calls; }, release };
}

test('manual reconciler has no provider or Agent Run call path', () => {
  const source = readFileSync(new URL('../src/sqlite-real-hh-manual-reconciler.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:https?:\/\/|fetch\(|transport\.search|search\.run\(|launchAgentRun|runAgent|spawnAgent)/i);
});

test('exact manual snapshot resolves unknown, enables accepted receipt, and replays audit safely', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.runs.listAcceptedManualReceipts(profileId, vacancyId), []);
  const reconciler = f.openReconciler();
  const first = reconciler.reconcile(f.command);
  assert.equal(first.kind, 'reconciled');
  const schema = JSON.parse(readFileSync(new URL('../contracts/v1-real-hh-manual-reconciliation-receipt.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(first.receipt), true, JSON.stringify(validate.errors));
  assert.equal(f.runs.get(context, f.command.runId).run.status, 'completed');
  assert.equal(f.runs.listAcceptedManualReceipts(profileId, vacancyId)[0].resultRevision, f.result.resultRevision);
  const restarted = f.openReconciler();
  assert.deepEqual(restarted.reconcile(f.command), { kind: 'replayed', receipt: first.receipt });
  assert.equal(restarted.reconcile({ ...f.command, operationId: 'manual_reconcile_synthetic_002' }).kind, 'run_already_reconciled');
  assert.equal(f.calls, 1);
  f.release();
});

test('operator, profile, job, criteria, source, revision and count mismatches stay unknown', async t => {
  const f = await fixture(t);
  const reconciler = f.openReconciler();
  const attempts = [
    [{ ...f.command, operator: { ...operator, scopes: [] } }, 'denied'],
    [{ ...f.command, profileId: 'profile_other' }, 'denied'],
    [{ ...f.command, vacancyId: 'vacancy_other' }, 'denied'],
    [{ ...f.command, jobId: 'hh_manual_wrong' }, 'binding_conflict'],
    [{ ...f.command, expectedCriteriaRevision: 'criteria_wrong' }, 'binding_conflict'],
    [{ ...f.command, expectedSourceRevision: 'source_wrong' }, 'snapshot_binding_conflict'],
    [{ ...f.command, expectedResultRevision: '0'.repeat(24) }, 'result_conflict'],
    [{ ...f.command, expectedResultCount: 2 }, 'result_conflict']
  ];
  for (const [command, kind] of attempts) assert.equal(reconciler.reconcile(command).kind, kind);
  assert.equal(f.runs.get(context, f.command.runId).run.status, 'outcome_unknown');
  assert.deepEqual(f.runs.listAcceptedManualReceipts(profileId, vacancyId), []);
  const absent = await fixture(t, { snapshot: false });
  assert.equal(absent.openReconciler().reconcile(absent.command).kind, 'snapshot_not_found');
  f.release(); absent.release();
});

test('receipt failure rolls run back; later reconciliation does not rewrite candidate snapshot', async t => {
  const f = await fixture(t);
  const failing = f.openReconciler({ onStage: stage => { if (stage === 'audit_receipt') throw new Error('invented_audit_crash'); } });
  assert.throws(() => failing.reconcile(f.command), /invented_audit_crash/);
  assert.equal(f.runs.get(context, f.command.runId).run.status, 'outcome_unknown');
  assert.deepEqual(f.state.latestSnapshot(profileId, vacancyId), f.result);
  assert.equal(f.openReconciler().reconcile(f.command).kind, 'reconciled');
  assert.equal(f.state.seenTotal(profileId, vacancyId), 1);
  f.release();
});
