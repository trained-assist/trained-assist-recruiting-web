import { createHash } from 'node:crypto';
import { nextOccurrenceAfter, scheduleIdFor, COLD_SEARCH_TIMEZONE } from './cold-search-schedules.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const allowed = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => fields.includes(key));

// Exact grammar emitted by trained-assist-hh-skill/src/hh-cold-search-cron.js
// intervalToCron. Other cron expressions require a reviewed parser/semantics.
export function legacyCronToPlan(cron) {
  if (typeof cron !== 'string' || cron !== cron.trim() || cron.length > 100) throw new Error('unsupported_legacy_cron');
  let match = cron.match(/^(\d{1,2}),(\d{1,2}) \* \* \* \*$/);
  if (match) {
    const minute = Number(match[1]);
    if (minute > 29 || Number(match[2]) !== minute + 30 || match[1] !== String(minute) || match[2] !== String(minute + 30))
      throw new Error('unsupported_legacy_cron');
    return { requestedIntervalHours: 0.5, intervalHours: 0.5, mode: 'half_hour', minute };
  }
  match = cron.match(/^(\d{1,2}) \* \* \* \*$/);
  if (match) {
    const minute = Number(match[1]);
    if (minute > 59 || match[1] !== String(minute)) throw new Error('unsupported_legacy_cron');
    return { requestedIntervalHours: 1, intervalHours: 1, mode: 'hour_step', minute, hourPhase: 0 };
  }
  match = cron.match(/^(\d{1,2}) (\d{1,2})-23\/(2|3|4|6|8|12) \* \* \*$/);
  if (match) {
    const minute = Number(match[1]); const phase = Number(match[2]); const step = Number(match[3]);
    if (minute > 59 || phase >= step || match[1] !== String(minute) || match[2] !== String(phase))
      throw new Error('unsupported_legacy_cron');
    return { requestedIntervalHours: step, intervalHours: step, mode: 'hour_step', minute, hourPhase: phase };
  }
  match = cron.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (match) {
    const minute = Number(match[1]); const hour = Number(match[2]);
    if (minute > 59 || hour < 7 || hour > 18 || match[1] !== String(minute) || match[2] !== String(hour))
      throw new Error('unsupported_legacy_cron');
    return { requestedIntervalHours: 24, intervalHours: 24, mode: 'day_step', days: 1, minute, hour };
  }
  match = cron.match(/^(\d{1,2}) (\d{1,2}) \*\/(\d{1,2}) \* \*$/);
  if (match) {
    const minute = Number(match[1]); const hour = Number(match[2]); const days = Number(match[3]);
    if (minute > 59 || hour < 7 || hour > 18 || days < 2 || days > 31 ||
        match[1] !== String(minute) || match[2] !== String(hour) || match[3] !== String(days))
      throw new Error('unsupported_legacy_cron');
    return { requestedIntervalHours: days * 24, intervalHours: days * 24, mode: 'day_step', days, minute, hour };
  }
  throw new Error('unsupported_legacy_cron');
}

export class R03LegacyScheduleImport {
  constructor({ repository, bindProfile = () => null, isVacancyOwned = () => false,
    clock = () => new Date(), onStage = () => {} } = {}) {
    if (typeof repository?.persistSchedule !== 'function' || !repository.db ||
        typeof bindProfile !== 'function' || typeof isVacancyOwned !== 'function' ||
        typeof clock !== 'function' || typeof onStage !== 'function')
      throw new TypeError('schedule import ports required');
    this.repository = repository;
    this.bindProfile = bindProfile;
    this.isVacancyOwned = isVacancyOwned;
    this.clock = clock;
    this.onStage = onStage;
    this.db = repository.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS r03_legacy_schedule_import (
      legacy_job_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL UNIQUE, definition_digest TEXT NOT NULL,
      original_cron TEXT NOT NULL
    )`);
    this.byLegacy = this.db.prepare('SELECT * FROM r03_legacy_schedule_import WHERE legacy_job_id=?');
    this.insert = this.db.prepare(`INSERT INTO r03_legacy_schedule_import
      (legacy_job_id,migration_id,schedule_id,definition_digest,original_cron) VALUES(?,?,?,?,?)`);
  }

  plan(envelope) {
    if (!allowed(envelope, ['version', 'migrationId', 'definitions']) || envelope.version !== 'legacy-hh-schedules-v1' ||
        !safeId(envelope.migrationId) || !Array.isArray(envelope.definitions) ||
        envelope.definitions.length < 1 || envelope.definitions.length > 100)
      throw new Error('invalid_legacy_schedule_manifest');
    const ids = new Set(); const schedules = new Set();
    return envelope.definitions.map(definition => {
      if (!allowed(definition, ['legacyJobId', 'sourceProfileRef', 'vacancyId', 'name', 'action', 'arguments',
        'cron', 'timezone', 'enabled', 'lastStatus']) || !safeId(definition.legacyJobId) ||
          typeof definition.sourceProfileRef !== 'string' || definition.sourceProfileRef.length < 1 ||
          !safeId(definition.vacancyId) || definition.name !== `cold-search:${definition.vacancyId}` ||
          definition.action !== 'hh_proactive_search' || !allowed(definition.arguments, ['vacancy_id']) ||
          Object.keys(definition.arguments).length !== 1 || definition.arguments.vacancy_id !== definition.vacancyId ||
          definition.timezone !== COLD_SEARCH_TIMEZONE || definition.enabled !== false ||
          !['success', 'failed', 'unknown'].includes(definition.lastStatus) || ids.has(definition.legacyJobId))
        throw new Error('invalid_legacy_schedule_definition');
      const profileId = this.bindProfile(definition.sourceProfileRef);
      if (!safeId(profileId) || !this.isVacancyOwned(profileId, definition.vacancyId))
        throw new Error('legacy_schedule_binding_denied');
      const scheduleId = scheduleIdFor(profileId, definition.vacancyId);
      if (schedules.has(scheduleId)) throw new Error('duplicate_legacy_schedule_vacancy');
      ids.add(definition.legacyJobId); schedules.add(scheduleId);
      const plan = legacyCronToPlan(definition.cron);
      return { profileId, scheduleId, definition, plan,
        definitionDigest: hash({ profileId, definition }) };
    });
  }

  import(envelope) {
    const planned = this.plan(envelope);
    const at = this.clock().toISOString();
    const summary = { imported: 0, replayed: 0, quarantined: 0, unknown: 0 };
    return this.db.transaction(() => {
      for (const { profileId, scheduleId, definition, plan, definitionDigest } of planned) {
        const previous = this.byLegacy.get(definition.legacyJobId);
        if (previous) {
          if (previous.migration_id !== envelope.migrationId || previous.schedule_id !== scheduleId ||
              previous.definition_digest !== definitionDigest || previous.original_cron !== definition.cron)
            throw new Error('legacy_schedule_import_conflict');
          summary.replayed++;
          continue;
        }
        if (this.repository.getSchedule(scheduleId)) throw new Error('legacy_schedule_target_conflict');
        const nextRunAt = nextOccurrenceAfter(plan, at);
        const quarantineId = `migration_pending_${hash(definition.legacyJobId).slice(0, 16)}`;
        this.repository.persistSchedule({ scheduleId, legacyJobId: definition.legacyJobId,
          profileId, vacancyId: definition.vacancyId, enabled: false,
          jobArguments: { vacancyId: definition.vacancyId }, timezone: COLD_SEARCH_TIMEZONE,
          interval_hours: plan.intervalHours, requested_interval_hours: plan.requestedIntervalHours,
          plan, criteriaRevision: null, criteria: null, nextRunAt,
          leaseOwner: null, leaseUntil: null, blockedByUnknownOccurrenceId: quarantineId,
          migrationQuarantine: { migrationId: envelope.migrationId, reason: definition.lastStatus === 'unknown'
            ? 'legacy_outcome_unknown' : 'cutover_review_required' },
          legacyCron: definition.cron, createdAt: at, updatedAt: at });
        this.insert.run(definition.legacyJobId, envelope.migrationId, scheduleId, definitionDigest, definition.cron);
        this.onStage('schedule_imported');
        summary.imported++; summary.quarantined++;
        if (definition.lastStatus === 'unknown') summary.unknown++;
      }
      return summary;
    }).immediate();
  }
}
