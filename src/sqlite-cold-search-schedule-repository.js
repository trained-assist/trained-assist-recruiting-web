import { chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { latestDueSlot, occurrenceId } from './cold-search-schedules.js';

const encode = value => JSON.stringify(value);
const decode = row => row ? JSON.parse(row.payload) : null;

// One SQLite file is shared by the web process and minute-timer worker on one
// host. Each claim serializes writers with BEGIN IMMEDIATE; WAL permits readers.
export class SqliteColdSearchScheduleRepository {
  constructor(filename) {
    if (typeof filename !== 'string' || !filename || filename === ':memory:') throw new TypeError('a durable SQLite filename is required');
    // SQLite creates -wal and -shm beside the main file. A private directory
    // protects all three even when SQLite chooses broader sidecar file modes.
    if (statSync(dirname(filename)).mode & 0o077) throw new Error('SQLite schedule directory must be owner-only (0700)');
    this.db = new Database(filename, { timeout: 5000 });
    chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cold_search_schedules (
        schedule_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        legacy_job_id TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        next_run_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        blocked_by_unknown_occurrence_id TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cold_search_occurrences (
        occurrence_id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES cold_search_schedules(schedule_id),
        profile_id TEXT NOT NULL,
        legacy_job_id TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        payload TEXT NOT NULL,
        UNIQUE (legacy_job_id, scheduled_at)
      );
      CREATE INDEX IF NOT EXISTS cold_search_due_idx
        ON cold_search_schedules(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS cold_search_occurrence_owner_idx
        ON cold_search_occurrences(profile_id, scheduled_at);
      CREATE INDEX IF NOT EXISTS cold_search_running_idx
        ON cold_search_occurrences(status, lease_until);
    `);
    this.scheduleById = this.db.prepare('SELECT payload FROM cold_search_schedules WHERE schedule_id = ?');
    this.occurrenceById = this.db.prepare('SELECT payload FROM cold_search_occurrences WHERE occurrence_id = ?');
    this.writeSchedule = this.db.prepare(`INSERT INTO cold_search_schedules
      (schedule_id, profile_id, legacy_job_id, enabled, next_run_at, lease_owner, lease_until, blocked_by_unknown_occurrence_id, payload)
      VALUES (@scheduleId, @profileId, @legacyJobId, @enabled, @nextRunAt, @leaseOwner, @leaseUntil, @blocked, @payload)
      ON CONFLICT(schedule_id) DO UPDATE SET
        profile_id=excluded.profile_id, legacy_job_id=excluded.legacy_job_id,
        enabled=excluded.enabled, next_run_at=excluded.next_run_at,
        lease_owner=excluded.lease_owner, lease_until=excluded.lease_until,
        blocked_by_unknown_occurrence_id=excluded.blocked_by_unknown_occurrence_id,
        payload=excluded.payload`);
    this.writeOccurrence = this.db.prepare(`INSERT INTO cold_search_occurrences
      (occurrence_id, schedule_id, profile_id, legacy_job_id, scheduled_at, status, lease_owner, lease_until, payload)
      VALUES (@occurrenceId, @scheduleId, @profileId, @legacyJobId, @scheduledAt, @status, @leaseOwner, @leaseUntil, @payload)`);
    this.updateOccurrence = this.db.prepare(`UPDATE cold_search_occurrences SET status=@status,
      lease_owner=@leaseOwner, lease_until=@leaseUntil, payload=@payload
      WHERE occurrence_id=@occurrenceId`);
  }

  close() { this.db.close(); }

  persistSchedule(value) {
    this.writeSchedule.run({
      scheduleId: value.scheduleId, profileId: value.profileId,
      legacyJobId: value.legacyJobId, enabled: Number(value.enabled),
      nextRunAt: value.nextRunAt, leaseOwner: value.leaseOwner,
      leaseUntil: value.leaseUntil, blocked: value.blockedByUnknownOccurrenceId,
      payload: encode(value)
    });
  }

  persistOccurrence(value) {
    this.updateOccurrence.run({
      occurrenceId: value.occurrenceId, status: value.status,
      leaseOwner: value.leaseOwner, leaseUntil: value.leaseUntil,
      payload: encode(value)
    });
  }

  upsertSchedule(schedule, expectedNextRunAt = null) {
    return this.db.transaction(() => {
      const current = this.getSchedule(schedule.scheduleId);
      // A concurrent tick may have claimed/advanced the row since the caller
      // read it. Do not let a UI command erase that in-flight state.
      const slotAdvanced = current && current.nextRunAt !== expectedNextRunAt;
      const value = {
        ...schedule,
        // If a tick advanced the slot while criteria resolution was pending,
        // preserve the durable cursor even if the lease has already finished.
        nextRunAt: slotAdvanced ? current.nextRunAt : schedule.nextRunAt,
        leaseOwner: current ? current.leaseOwner : schedule.leaseOwner,
        leaseUntil: current ? current.leaseUntil : schedule.leaseUntil,
        blockedByUnknownOccurrenceId: current ? current.blockedByUnknownOccurrenceId : schedule.blockedByUnknownOccurrenceId
      };
      this.persistSchedule(value);
      return structuredClone(value);
    }).immediate();
  }

  getSchedule(id) { return decode(this.scheduleById.get(id)); }
  listAllSchedules() { return this.db.prepare('SELECT payload FROM cold_search_schedules ORDER BY schedule_id').all().map(decode); }
  listSchedules(profileId) { return this.db.prepare('SELECT payload FROM cold_search_schedules WHERE profile_id = ? ORDER BY schedule_id').all(profileId).map(decode); }
  getOccurrence(id) { return decode(this.occurrenceById.get(id)); }
  listOccurrences(profileId) { return this.db.prepare('SELECT payload FROM cold_search_occurrences WHERE profile_id = ? ORDER BY scheduled_at, occurrence_id').all(profileId).map(decode); }

  claimDueOccurrences({ now, workerId, leaseUntil }) {
    if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(leaseUntil)) || Date.parse(leaseUntil) <= Date.parse(now) || !workerId) throw new TypeError('valid claim time, lease, and worker are required');
    return this.db.transaction(() => {
      // Expired work is ambiguous: it might already have called HH. Quarantine
      // before considering another due slot, including after a process crash.
      const expired = this.db.prepare(`SELECT payload FROM cold_search_occurrences
        WHERE status = 'running' AND lease_until <= ? ORDER BY scheduled_at`).all(now).map(decode);
      for (const occurrence of expired) {
        occurrence.status = 'outcome_unknown';
        occurrence.finishedAt = now;
        occurrence.errorCode = 'worker_lease_expired';
        occurrence.leaseOwner = null;
        occurrence.leaseUntil = null;
        this.persistOccurrence(occurrence);
        const schedule = this.getSchedule(occurrence.scheduleId);
        if (schedule) {
          schedule.blockedByUnknownOccurrenceId = occurrence.occurrenceId;
          schedule.leaseOwner = null;
          schedule.leaseUntil = null;
          this.persistSchedule(schedule);
        }
      }
      const dueSchedules = this.db.prepare(`SELECT payload FROM cold_search_schedules
        WHERE enabled = 1 AND next_run_at <= ? AND blocked_by_unknown_occurrence_id IS NULL
          AND (lease_owner IS NULL OR lease_until <= ?) ORDER BY next_run_at, schedule_id`).all(now, now).map(decode);
      const claimed = [];
      for (const schedule of dueSchedules) {
        const due = latestDueSlot(schedule.plan, schedule.nextRunAt, now);
        schedule.nextRunAt = due.nextRunAt;
        const alreadyExists = this.db.prepare(`SELECT occurrence_id FROM cold_search_occurrences
          WHERE legacy_job_id = ? AND scheduled_at = ?`).get(schedule.legacyJobId, due.scheduledAt);
        if (alreadyExists) {
          // A unique conflict means this slot has a recorded result. Advance
          // only; never create a second external search for the same slot.
          this.persistSchedule(schedule);
          continue;
        }
        schedule.leaseOwner = workerId;
        schedule.leaseUntil = leaseUntil;
        const occurrence = {
          occurrenceId: occurrenceId(schedule.legacyJobId, due.scheduledAt),
          scheduleId: schedule.scheduleId, profileId: schedule.profileId,
          vacancyId: schedule.vacancyId, legacyJobId: schedule.legacyJobId,
          scheduledAt: due.scheduledAt, coalescedMissedCount: due.missedCount,
          criteriaRevision: null, status: 'running', leaseOwner: workerId,
          leaseUntil, startedAt: now, finishedAt: null, errorCode: null,
          jobId: null, snapshot: null
        };
        this.writeOccurrence.run({
          occurrenceId: occurrence.occurrenceId, scheduleId: occurrence.scheduleId,
          profileId: occurrence.profileId, legacyJobId: occurrence.legacyJobId,
          scheduledAt: occurrence.scheduledAt, status: occurrence.status,
          leaseOwner: occurrence.leaseOwner, leaseUntil: occurrence.leaseUntil,
          payload: encode(occurrence)
        });
        this.persistSchedule(schedule);
        claimed.push({ schedule: structuredClone(schedule), occurrence: structuredClone(occurrence) });
      }
      return claimed;
    }).immediate();
  }

  finishOccurrence(id, workerId, result, now) {
    if (!['succeeded', 'rejected', 'outcome_unknown'].includes(result?.status) || !Number.isFinite(Date.parse(now))) throw new TypeError('valid terminal outcome and time are required');
    return this.db.transaction(() => {
      const row = this.getOccurrence(id);
      if (!row || row.status !== 'running' || row.leaseOwner !== workerId || row.leaseUntil <= now) return false;
      const schedule = this.getSchedule(row.scheduleId);
      if (!schedule || schedule.leaseOwner !== workerId || schedule.leaseUntil <= now) return false;
      Object.assign(row, structuredClone(result), { status: result.status, finishedAt: now, leaseOwner: null, leaseUntil: null });
      this.persistOccurrence(row);
      if (result.status === 'outcome_unknown') schedule.blockedByUnknownOccurrenceId = row.occurrenceId;
      schedule.leaseOwner = null;
      schedule.leaseUntil = null;
      this.persistSchedule(schedule);
      return true;
    }).immediate();
  }

  renewOccurrenceLease(id, workerId, now, leaseUntil) {
    if (typeof id !== 'string' || !id || typeof workerId !== 'string' || !workerId ||
        !Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(leaseUntil)) ||
        leaseUntil <= now) throw new TypeError('valid occurrence heartbeat required');
    return this.db.transaction(() => {
      const row = this.getOccurrence(id);
      if (!row || row.status !== 'running' || row.leaseOwner !== workerId || row.leaseUntil <= now ||
          row.leaseUntil >= leaseUntil) return false;
      const schedule = this.getSchedule(row.scheduleId);
      if (!schedule || schedule.leaseOwner !== workerId || schedule.leaseUntil !== row.leaseUntil ||
          schedule.leaseUntil <= now) return false;
      row.leaseUntil = leaseUntil;
      schedule.leaseUntil = leaseUntil;
      this.persistOccurrence(row);
      this.persistSchedule(schedule);
      return true;
    }).immediate();
  }
}
