import { createHmac } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const categories = ['allCandidates', 'seenIds', 'snapshots', 'queryCaches', 'comments', 'atsConfigs', 'schedules'];
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sourceRef = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !/[\x00-\x1f\/\\]/.test(value) && value !== '.' && value !== '..';
const digest = (key, value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
const list = value => Array.isArray(value) && value.length <= 50_000;
const unique = values => new Set(values).size === values.length;
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key));

// Only metadata projections enter this boundary. The private extractor must
// retain raw JSON and secrets outside this repository and this staging DB.
export class R03LegacyRehearsal {
  constructor({ filename, hmacKey, bindProfile = () => null, isVacancyOwned = () => false,
    onStage = () => {} } = {}) {
    if (typeof filename !== 'string' || !filename || filename === ':memory:' || statSync(dirname(filename)).mode & 0o077)
      throw new TypeError('private rehearsal filename required');
    if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32 || typeof bindProfile !== 'function' ||
        typeof isVacancyOwned !== 'function' || typeof onStage !== 'function')
      throw new TypeError('private HMAC key and binding ports required');
    this.hmacKey = hmacKey;
    this.bindProfile = bindProfile;
    this.isVacancyOwned = isVacancyOwned;
    this.onStage = onStage;
    this.db = new Database(filename, { timeout: 5000 });
    chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS r03_legacy_rehearsal (
      migration_id TEXT PRIMARY KEY, manifest_digest TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS r03_legacy_rehearsal_profile (
      migration_id TEXT NOT NULL REFERENCES r03_legacy_rehearsal(migration_id),
      profile_id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(migration_id, profile_id)
    )`);
    this.byMigration = this.db.prepare('SELECT manifest_digest,payload FROM r03_legacy_rehearsal WHERE migration_id=?');
    this.insertManifest = this.db.prepare('INSERT INTO r03_legacy_rehearsal(migration_id,manifest_digest,payload) VALUES(?,?,?)');
    this.insertProfile = this.db.prepare('INSERT INTO r03_legacy_rehearsal_profile(migration_id,profile_id,payload) VALUES(?,?,?)');
  }

  close() { this.db.close(); }

  plan(envelope) {
    if (!keys(envelope, ['migrationId', 'profiles', 'expectedScheduleCount', 'expectedCounts']) ||
        !safeId(envelope.migrationId) || !list(envelope.profiles) || envelope.profiles.length === 0 || envelope.profiles.length > 100 ||
        !Number.isSafeInteger(envelope.expectedScheduleCount) || envelope.expectedScheduleCount < 0 ||
        !keys(envelope.expectedCounts, categories) || categories.some(category =>
          !Number.isSafeInteger(envelope.expectedCounts[category]) || envelope.expectedCounts[category] < 0))
      throw new Error('invalid_legacy_rehearsal_manifest');
    const profiles = [];
    const refs = new Set();
    const owners = new Set();
    const allLegacyJobIds = new Set();
    const totals = Object.fromEntries(categories.map(category => [category, 0]));
    let wildcardCandidates = 0;
    let unknownSchedules = 0;
    let generatedQueryCaches = 0;
    for (const entry of envelope.profiles) {
      if (!keys(entry, ['sourceProfileRef', ...categories]) || !sourceRef(entry.sourceProfileRef) || refs.has(entry.sourceProfileRef) ||
          categories.some(category => !list(entry[category]))) throw new Error('invalid_legacy_profile_inventory');
      refs.add(entry.sourceProfileRef);
      const profileId = this.bindProfile(entry.sourceProfileRef);
      if (!safeId(profileId) || owners.has(profileId)) throw new Error('legacy_profile_binding_conflict');
      owners.add(profileId);
      const candidates = new Map();
      for (const candidate of entry.allCandidates) {
        if (!keys(candidate, ['resumeId', 'vacancyIds']) || !safeId(candidate.resumeId) || !list(candidate.vacancyIds) ||
            !unique(candidate.vacancyIds) || candidates.has(candidate.resumeId) ||
            candidate.vacancyIds.some(vacancyId => !safeId(vacancyId) || !this.isVacancyOwned(profileId, vacancyId)))
          throw new Error('invalid_legacy_candidate_inventory');
        candidates.set(candidate.resumeId, candidate.vacancyIds);
        if (candidate.vacancyIds.length === 0) wildcardCandidates++;
      }
      const owned = vacancyId => safeId(vacancyId) && this.isVacancyOwned(profileId, vacancyId);
      const linked = (resumeId, vacancyId) => candidates.has(resumeId) &&
        (candidates.get(resumeId).length === 0 || candidates.get(resumeId).includes(vacancyId));
      const seenKeys = new Set();
      for (const row of entry.seenIds) {
        const key = JSON.stringify([row?.vacancyId, row?.resumeId]);
        if (!keys(row, ['resumeId', 'vacancyId', 'firstSeenAt']) || !owned(row.vacancyId) ||
            !linked(row.resumeId, row.vacancyId) || !Number.isFinite(Date.parse(row.firstSeenAt)) || seenKeys.has(key))
          throw new Error('invalid_legacy_seen_inventory');
        seenKeys.add(key);
      }
      const snapshotJobs = new Set();
      for (const row of entry.snapshots) {
        if (!keys(row, ['jobId', 'vacancyId', 'searchedAt', 'candidateIds']) || !safeId(row.jobId) ||
            !owned(row.vacancyId) || !Number.isFinite(Date.parse(row.searchedAt)) ||
            !list(row.candidateIds) || !unique(row.candidateIds) ||
            row.candidateIds.some(id => !linked(id, row.vacancyId)) || snapshotJobs.has(row.jobId))
          throw new Error('invalid_legacy_snapshot_inventory');
        snapshotJobs.add(row.jobId);
      }
      const queryVacancies = new Set();
      for (const row of entry.queryCaches) {
        if (!keys(row, ['vacancyId', 'manual', 'queryCount']) || !owned(row.vacancyId) ||
            typeof row.manual !== 'boolean' || !Number.isSafeInteger(row.queryCount) || row.queryCount < 0 ||
            row.queryCount > 15 || queryVacancies.has(row.vacancyId))
          throw new Error('invalid_legacy_query_inventory');
        queryVacancies.add(row.vacancyId);
        if (!row.manual) generatedQueryCaches++;
      }
      const commentKeys = new Set();
      for (const row of entry.comments) {
        const key = JSON.stringify([row?.vacancyId, row?.resumeId]);
        if (!keys(row, ['resumeId', 'vacancyId']) || !owned(row.vacancyId) ||
            !linked(row.resumeId, row.vacancyId) || commentKeys.has(key))
          throw new Error('invalid_legacy_comment_inventory');
        commentKeys.add(key);
      }
      const atsVacancies = new Set();
      for (const row of entry.atsConfigs) {
        if (!keys(row, ['vacancyId']) || !owned(row.vacancyId)) throw new Error('invalid_legacy_ats_inventory');
        if (atsVacancies.has(row.vacancyId)) throw new Error('duplicate_legacy_ats_inventory');
        atsVacancies.add(row.vacancyId);
      }
      const scheduleIds = new Set();
      const scheduledVacancies = new Set();
      for (const row of entry.schedules) {
        if (!keys(row, ['legacyJobId', 'vacancyId', 'cron', 'timezone', 'enabled', 'lastStatus']) ||
            !safeId(row.legacyJobId) || scheduleIds.has(row.legacyJobId) || allLegacyJobIds.has(row.legacyJobId) ||
            !owned(row.vacancyId) || !atsVacancies.has(row.vacancyId) || scheduledVacancies.has(row.vacancyId) ||
            typeof row.cron !== 'string' || !/^[\d*,\-/ ]{5,100}$/.test(row.cron) ||
            row.cron.trim().split(/\s+/).length !== 5 || row.timezone !== 'Europe/Moscow' ||
            row.enabled !== false || !['success', 'failed', 'unknown'].includes(row.lastStatus))
          throw new Error('invalid_legacy_schedule_inventory');
        scheduleIds.add(row.legacyJobId);
        scheduledVacancies.add(row.vacancyId);
        allLegacyJobIds.add(row.legacyJobId);
        if (row.lastStatus === 'unknown') unknownSchedules++;
      }
      const counts = Object.fromEntries(categories.map(category => [category, entry[category].length]));
      for (const category of categories) totals[category] += counts[category];
      profiles.push({ profileId, counts, inventoryDigest: digest(this.hmacKey, entry),
        wildcardCandidates: entry.allCandidates.filter(candidate => candidate.vacancyIds.length === 0).length,
        unknownSchedules: entry.schedules.filter(schedule => schedule.lastStatus === 'unknown').length });
    }
    if (totals.schedules !== envelope.expectedScheduleCount ||
        categories.some(category => totals[category] !== envelope.expectedCounts[category]))
      throw new Error('legacy_inventory_count_mismatch');
    return { migrationId: envelope.migrationId, manifestDigest: digest(this.hmacKey, envelope),
      totals, profiles, quarantine: { wildcardCandidates, unknownSchedules, generatedQueryCaches },
      materialized: false };
  }

  stage(envelope) {
    const plan = this.plan(envelope);
    return this.db.transaction(() => {
      const existing = this.byMigration.get(plan.migrationId);
      if (existing) return existing.manifest_digest === plan.manifestDigest
        ? { kind: 'replayed', plan: JSON.parse(existing.payload) } : { kind: 'migration_conflict' };
      this.insertManifest.run(plan.migrationId, plan.manifestDigest, JSON.stringify(plan));
      for (const profile of plan.profiles) {
        this.insertProfile.run(plan.migrationId, profile.profileId, JSON.stringify(profile));
        this.onStage('profile_metadata');
      }
      this.onStage('manifest_metadata');
      return { kind: 'staged', plan };
    }).immediate();
  }
}
