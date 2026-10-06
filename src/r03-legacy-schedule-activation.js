import { createHash } from 'node:crypto';
import { COLD_SEARCH_TIMEZONE, nextOccurrenceAfter, scheduleIdFor } from './cold-search-schedules.js';
import { legacyCronToPlan } from './r03-legacy-schedule-import.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readyFields = ['profileBound', 'vacancyBound', 'atsReady', 'queryReady',
  'hhCredentialVerified', 'candidateRestoreVerified', 'backgroundWriterReconciled'];

// Separate from the synthetic user schedule handler. This operator path can
// release an imported schedule only after private migration and investigation.
export class R03LegacyScheduleActivation {
  constructor({ repository, authorizeOperator, checkReady, clock = () => new Date() } = {}) {
    if (!repository?.db || typeof repository.getSchedule !== 'function' ||
        typeof authorizeOperator !== 'function' || typeof checkReady !== 'function' ||
        typeof clock !== 'function') throw new TypeError('legacy activation ports required');
    this.repository = repository;
    this.authorizeOperator = authorizeOperator;
    this.checkReady = checkReady;
    this.clock = clock;
    this.db = repository.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS r03_legacy_schedule_activation (
      schedule_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, receipt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS r03_legacy_schedule_suspension (
      schedule_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, receipt TEXT NOT NULL
    )`);
    this.imported = this.db.prepare('SELECT * FROM r03_legacy_schedule_import WHERE schedule_id=?');
    this.receipt = this.db.prepare('SELECT request_digest,receipt FROM r03_legacy_schedule_activation WHERE schedule_id=?');
    this.writeReceipt = this.db.prepare('INSERT INTO r03_legacy_schedule_activation(schedule_id,request_digest,receipt) VALUES(?,?,?)');
    this.suspension = this.db.prepare('SELECT request_digest,receipt FROM r03_legacy_schedule_suspension WHERE schedule_id=?');
    this.writeSuspension = this.db.prepare('INSERT INTO r03_legacy_schedule_suspension(schedule_id,request_digest,receipt) VALUES(?,?,?)');
    this.occurrenceCount = this.db.prepare('SELECT COUNT(*) AS n FROM cold_search_occurrences WHERE schedule_id=?');
  }

  activate(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command) ||
        Object.keys(command).sort().join(',') !==
          ['definitionDigest', 'evidenceDigest', 'legacyJobId', 'migrationId', 'operatorId',
            'scheduleId', 'unknownDisposition'].sort().join(',') ||
        ![command.scheduleId, command.legacyJobId, command.migrationId, command.operatorId].every(safeId) ||
        !/^[a-f0-9]{64}$/.test(command.definitionDigest) || !/^[a-f0-9]{64}$/.test(command.evidenceDigest) ||
        !['not_applicable', 'confirmed_no_dispatch', 'reconciled_in_target'].includes(command.unknownDisposition))
      throw new Error('invalid_legacy_activation_command');
    if (!this.authorizeOperator(command.operatorId, 'recruiting.legacyScheduleActivate'))
      throw new Error('legacy_activation_operator_denied');
    const at = this.clock().toISOString();
    if (!Number.isFinite(Date.parse(at))) throw new Error('invalid_legacy_activation_clock');
    const requestDigest = digest(command);
    return this.db.transaction(() => {
      const prior = this.receipt.get(command.scheduleId);
      if (prior) return prior.request_digest === requestDigest
        ? { kind: 'replayed', receipt: JSON.parse(prior.receipt) }
        : { kind: 'activation_conflict' };
      const imported = this.imported.get(command.scheduleId);
      const schedule = this.repository.getSchedule(command.scheduleId);
      if (!imported || !schedule || imported.legacy_job_id !== command.legacyJobId ||
          imported.migration_id !== command.migrationId || imported.definition_digest !== command.definitionDigest ||
          schedule.legacyJobId !== command.legacyJobId || schedule.scheduleId !== scheduleIdFor(schedule.profileId, schedule.vacancyId) ||
          schedule.timezone !== COLD_SEARCH_TIMEZONE || schedule.legacyCron !== imported.original_cron ||
          JSON.stringify(schedule.plan) !== JSON.stringify(legacyCronToPlan(imported.original_cron)) ||
          schedule.enabled || schedule.leaseOwner || schedule.migrationQuarantine?.migrationId !== command.migrationId ||
          !schedule.blockedByUnknownOccurrenceId || this.occurrenceCount.get(command.scheduleId).n)
        throw new Error('legacy_activation_state_mismatch');
      const unknown = schedule.migrationQuarantine.reason === 'legacy_outcome_unknown';
      if (unknown && command.unknownDisposition === 'not_applicable' ||
          !unknown && command.unknownDisposition !== 'not_applicable')
        throw new Error('legacy_unknown_requires_investigation');
      const readiness = this.checkReady(schedule.profileId, schedule.vacancyId, schedule);
      if (!readiness || readyFields.some(field => readiness[field] !== true) ||
          Object.keys(readiness).some(field => !readyFields.includes(field)))
        throw new Error('legacy_activation_not_ready');
      const nextRunAt = nextOccurrenceAfter(schedule.plan, at);
      const activated = { ...schedule, enabled: true, nextRunAt, leaseOwner: null,
        leaseUntil: null, blockedByUnknownOccurrenceId: null, migrationQuarantine: null,
        activatedAt: at, updatedAt: at };
      this.repository.persistSchedule(activated);
      const receipt = { scheduleId: command.scheduleId, legacyJobId: command.legacyJobId,
        migrationId: command.migrationId, operatorId: command.operatorId,
        unknownDisposition: command.unknownDisposition, evidenceDigest: command.evidenceDigest,
        definitionDigest: command.definitionDigest, activatedAt: at, nextRunAt };
      this.writeReceipt.run(command.scheduleId, requestDigest, JSON.stringify(receipt));
      return { kind: 'activated', receipt };
    }).immediate();
  }

  suspend(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command) ||
        Object.keys(command).sort().join(',') !== ['evidenceDigest', 'operatorId', 'reason', 'scheduleId'].sort().join(',') ||
        !safeId(command.scheduleId) || !safeId(command.operatorId) ||
        !['cutover_rollback', 'readiness_revoked'].includes(command.reason) ||
        !/^[a-f0-9]{64}$/.test(command.evidenceDigest)) throw new Error('invalid_legacy_suspension_command');
    if (!this.authorizeOperator(command.operatorId, 'recruiting.legacyScheduleSuspend'))
      throw new Error('legacy_activation_operator_denied');
    const at = this.clock().toISOString();
    const requestDigest = digest(command);
    return this.db.transaction(() => {
      const prior = this.suspension.get(command.scheduleId);
      if (prior) return prior.request_digest === requestDigest
        ? { kind: 'replayed', receipt: JSON.parse(prior.receipt) }
        : { kind: 'suspension_conflict' };
      const activation = this.receipt.get(command.scheduleId);
      const schedule = this.repository.getSchedule(command.scheduleId);
      if (!activation || !schedule || !schedule.enabled || schedule.leaseOwner || schedule.migrationQuarantine)
        throw new Error('legacy_suspension_state_mismatch');
      const activated = JSON.parse(activation.receipt);
      this.repository.persistSchedule({ ...schedule, enabled: false,
        blockedByUnknownOccurrenceId: `migration_rollback_${digest(command.scheduleId).slice(0, 16)}`,
        migrationQuarantine: { migrationId: activated.migrationId, reason: command.reason }, updatedAt: at });
      const receipt = { scheduleId: command.scheduleId, operatorId: command.operatorId,
        reason: command.reason, evidenceDigest: command.evidenceDigest, suspendedAt: at };
      this.writeSuspension.run(command.scheduleId, requestDigest, JSON.stringify(receipt));
      return { kind: 'suspended', receipt };
    }).immediate();
  }
}
