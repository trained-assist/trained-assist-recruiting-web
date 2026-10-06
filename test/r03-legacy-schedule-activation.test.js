import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { R03LegacyScheduleImport } from '../src/r03-legacy-schedule-import.js';
import { R03LegacyScheduleActivation } from '../src/r03-legacy-schedule-activation.js';

const inventory = JSON.parse(readFileSync(new URL('../data/r03-legacy-inventory-golden.json', import.meta.url), 'utf8'));
const profileMap = { legacy_synthetic_work: 'profile_synthetic_work', legacy_synthetic_test: 'profile_synthetic_test' };
const definitions = inventory.profiles.flatMap(profile => profile.schedules.map(schedule => ({
  ...schedule, sourceProfileRef: profile.sourceProfileRef, name: `cold-search:${schedule.vacancyId}`,
  action: 'hh_proactive_search', arguments: { vacancy_id: schedule.vacancyId },
})));
const goodReadiness = () => ({ profileBound: true, vacancyBound: true, atsReady: true,
  queryReady: true, hhCredentialVerified: true, candidateRestoreVerified: true,
  backgroundWriterReconciled: true });

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'r03-legacy-activation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = new SqliteColdSearchScheduleRepository(join(dir, 'private.sqlite'));
  t.after(() => { if (repo.db.open) repo.close(); });
  const imported = new R03LegacyScheduleImport({ repository: repo,
    bindProfile: ref => profileMap[ref] || null, isVacancyOwned: () => true,
    clock: () => new Date('2026-10-06T06:00:00.000Z') });
  imported.import({ version: 'legacy-hh-schedules-v1', migrationId: 'migration_synthetic_001',
    definitions: structuredClone(definitions) });
  const activation = new R03LegacyScheduleActivation({ repository: repo,
    authorizeOperator: actor => actor === 'operator_synthetic_001', checkReady: options.checkReady || goodReadiness,
    clock: () => new Date('2026-10-07T06:00:00.000Z') });
  const target = repo.listAllSchedules().find(row => row.migrationQuarantine.reason === 'legacy_outcome_unknown');
  const receipt = activation.imported.get(target.scheduleId);
  const command = { scheduleId: target.scheduleId, legacyJobId: target.legacyJobId,
    migrationId: 'migration_synthetic_001', operatorId: 'operator_synthetic_001',
    definitionDigest: receipt.definition_digest, evidenceDigest: 'a'.repeat(64),
    unknownDisposition: 'reconciled_in_target' };
  return { repo, activation, command, target };
}

test('investigated legacy unknown activates at next future slot with one durable audit receipt', t => {
  const f = fixture(t);
  const result = f.activation.activate(f.command);
  assert.equal(result.kind, 'activated');
  assert.equal(result.receipt.unknownDisposition, 'reconciled_in_target');
  assert.ok(result.receipt.nextRunAt > '2026-10-07T06:00:00.000Z');
  const schedule = f.repo.getSchedule(f.target.scheduleId);
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.blockedByUnknownOccurrenceId, null);
  assert.equal(schedule.migrationQuarantine, null);
  assert.equal(schedule.legacyCron, f.target.legacyCron);
  assert.deepEqual(f.activation.activate(f.command), { kind: 'replayed', receipt: result.receipt });
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_schedule_activation').get().n, 1);
  assert.equal(f.activation.activate({ ...f.command, evidenceDigest: 'b'.repeat(64) }).kind, 'activation_conflict');
});

test('unknown without investigation, denied operator and incomplete readiness leave quarantine intact', t => {
  const f = fixture(t, { checkReady: () => ({ ...goodReadiness(), hhCredentialVerified: false }) });
  assert.throws(() => f.activation.activate({ ...f.command, operatorId: 'untrusted' }), /legacy_activation_operator_denied/);
  assert.throws(() => f.activation.activate({ ...f.command, unknownDisposition: 'not_applicable' }),
    /legacy_unknown_requires_investigation/);
  assert.throws(() => f.activation.activate(f.command), /legacy_activation_not_ready/);
  assert.equal(f.repo.getSchedule(f.target.scheduleId).enabled, false);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_schedule_activation').get().n, 0);
});

test('nonunknown definition needs cutover review but no unknown disposition', t => {
  const f = fixture(t);
  const selected = f.repo.listAllSchedules().find(row => row.migrationQuarantine.reason === 'cutover_review_required');
  const imported = f.activation.imported.get(selected.scheduleId);
  assert.throws(() => f.activation.activate({ ...f.command, scheduleId: selected.scheduleId,
    legacyJobId: selected.legacyJobId, definitionDigest: imported.definition_digest }),
  /legacy_unknown_requires_investigation/);
  assert.equal(f.activation.activate({ ...f.command, scheduleId: selected.scheduleId,
    legacyJobId: selected.legacyJobId, definitionDigest: imported.definition_digest,
    unknownDisposition: 'not_applicable' }).kind, 'activated');
});

test('operator rollback disables an activated schedule and keeps a durable audit receipt', t => {
  const f = fixture(t);
  f.activation.activate(f.command);
  const rollback = { scheduleId: f.command.scheduleId, operatorId: 'operator_synthetic_001',
    reason: 'cutover_rollback', evidenceDigest: 'b'.repeat(64) };
  const result = f.activation.suspend(rollback);
  assert.equal(result.kind, 'suspended');
  const stored = f.repo.getSchedule(f.command.scheduleId);
  assert.equal(stored.enabled, false);
  assert.equal(stored.migrationQuarantine.reason, 'cutover_rollback');
  assert.match(stored.blockedByUnknownOccurrenceId, /^migration_rollback_/);
  assert.deepEqual(f.activation.suspend(rollback), { kind: 'replayed', receipt: result.receipt });
  assert.equal(f.activation.suspend({ ...rollback, evidenceDigest: 'c'.repeat(64) }).kind, 'suspension_conflict');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_schedule_suspension').get().n, 1);
});

test('a changed imported plan cannot be activated even with a valid original receipt', t => {
  const f = fixture(t);
  const changed = f.repo.getSchedule(f.command.scheduleId);
  changed.plan.minute = (changed.plan.minute + 1) % 60;
  f.repo.persistSchedule(changed);
  assert.throws(() => f.activation.activate(f.command), /legacy_activation_state_mismatch/);
  assert.equal(f.repo.getSchedule(f.command.scheduleId).enabled, false);
});
