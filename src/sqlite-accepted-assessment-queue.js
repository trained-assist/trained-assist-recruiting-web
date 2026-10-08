import { chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { acceptedRealHhSnapshotIds } from './r03-accumulated-real-feed.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const validAssessment = value => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === 'atsScore,atsTag,knockout' &&
  Number.isFinite(value.atsScore) && value.atsScore >= 0 && value.atsScore <= 10 &&
  ['PASS', 'REVIEW', 'WEAK'].includes(value.atsTag) && value.knockout &&
  Object.keys(value.knockout).sort().join(',') === 'criteria,status' &&
  ['passed', 'failed'].includes(value.knockout.status) &&
  Array.isArray(value.knockout.criteria) && value.knockout.criteria.length <= 20 &&
  value.knockout.criteria.every(item => typeof item === 'string' && item.length <= 200) &&
  (value.knockout.status === 'passed' && value.knockout.criteria.length === 0 ||
    value.knockout.status === 'failed' && value.knockout.criteria.length > 0 && value.atsScore <= 2) &&
  Buffer.byteLength(JSON.stringify(value)) <= 8192;

// The web process needs only this read port; it never gets evaluator secrets
// or a queue writer merely to show pending/attention state.
export function createAcceptedAssessmentStatusReader(candidateState) {
  if (typeof candidateState?.assertScope !== 'function' || !candidateState?.db)
    throw new TypeError('assessment status read port required');
  return { statusFor(profileId, vacancyId, jobId, candidateId) {
    candidateState.assertScope(profileId, vacancyId);
    if (![jobId, candidateId].every(safeId)) throw new Error('assessment_scope_denied');
    const table = candidateState.db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='r03_accepted_assessment_queue'`).get();
    if (!table) return 'pending';
    const row = candidateState.db.prepare(`SELECT status FROM r03_accepted_assessment_queue
      WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`)
      .get(profileId, vacancyId, jobId, candidateId);
    return row?.status ?? 'pending';
  } };
}

// The accepted receipt fence is shared with the accumulated feed. This queue
// sees older accepted snapshots too; `unassessedLatest` would strand them.
export class SqliteAcceptedAssessmentQueue {
  constructor({ filename, candidateState, scheduleRepository,
    loadAcceptedManualReceipts = () => [], evaluate,
    currentCriteriaRevision, clock = () => new Date(), leaseMs = 60_000 } = {}) {
    if (typeof filename !== 'string' || !filename || filename === ':memory:' ||
        statSync(dirname(filename)).mode & 0o077 ||
        typeof candidateState?.resultPage !== 'function' ||
        typeof candidateState?.assessmentInputRevision !== 'function' ||
        typeof scheduleRepository?.listOccurrences !== 'function' ||
        typeof loadAcceptedManualReceipts !== 'function' ||
        typeof evaluate !== 'function' || typeof currentCriteriaRevision !== 'function' ||
        typeof clock !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 1000)
      throw new TypeError('accepted assessment queue ports required');
    this.candidateState = candidateState;
    this.scheduleRepository = scheduleRepository;
    this.loadAcceptedManualReceipts = loadAcceptedManualReceipts;
    this.evaluate = evaluate;
    this.currentCriteriaRevision = currentCriteriaRevision;
    this.clock = clock;
    this.leaseMs = leaseMs;
    this.db = new Database(filename, { timeout: 5000 });
    chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS r03_accepted_assessment_queue (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, job_id TEXT NOT NULL,
      resume_id TEXT NOT NULL, input_revision TEXT NOT NULL,
      status TEXT NOT NULL, lease_owner TEXT, lease_until TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(profile_id,vacancy_id,job_id,resume_id)
    );
    CREATE INDEX IF NOT EXISTS r03_assessment_due ON r03_accepted_assessment_queue
      (profile_id,vacancy_id,status,retry_at,created_at)`);
  }

  close() { this.db.close(); }

  accepted(profileId, vacancyId) {
    this.candidateState.assertScope(profileId, vacancyId);
    const accepted = acceptedRealHhSnapshotIds({ scheduleRepository: this.scheduleRepository,
      candidateState: this.candidateState, loadAcceptedManualReceipts: this.loadAcceptedManualReceipts,
      profileId, vacancyId });
    return [...new Set([...accepted.acceptedScheduledJobIds, ...accepted.acceptedManualJobIds])];
  }

  sync(profileId, vacancyId) {
    const jobIds = this.accepted(profileId, vacancyId);
    const now = this.clock().toISOString();
    if (!iso(now)) throw new Error('assessment_clock_invalid');
    let inserted = 0;
    for (const jobId of jobIds) {
      const first = this.candidateState.resultPage({ profileId, vacancyId, jobId, limit: 1 });
      if (!first) throw new Error('accepted_snapshot_unavailable');
      const snapshot = first.snapshot;
      const members = this.db.prepare(`SELECT resume_id,projection FROM real_hh_snapshot_member
        WHERE profile_id=? AND vacancy_id=? AND job_id=? ORDER BY position`).all(profileId, vacancyId, jobId);
      if (members.length !== snapshot.candidateCount || members.length > 20_000) throw new Error('accepted_snapshot_count_mismatch');
      inserted += this.db.transaction(() => {
        let added = 0;
        for (const member of members) {
          const candidate = JSON.parse(member.projection);
          const inputRevision = this.candidateState.assessmentInputRevision(snapshot, candidate);
          const assessed = this.db.prepare(`SELECT input_revision FROM real_hh_assessment
            WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`)
            .get(profileId, vacancyId, jobId, member.resume_id);
          if (assessed?.input_revision === inputRevision) continue;
          added += this.db.prepare(`INSERT OR IGNORE INTO r03_accepted_assessment_queue
            (profile_id,vacancy_id,job_id,resume_id,input_revision,status,created_at,updated_at)
            VALUES(?,?,?,?,?,'pending',?,?)`).run(profileId, vacancyId, jobId,
            member.resume_id, inputRevision, snapshot.searchedAt, now).changes;
        }
        return added;
      }).immediate();
    }
    return { acceptedJobs: jobIds.length, inserted };
  }

  claim(profileId, vacancyId, owner, limit = 10) {
    this.candidateState.assertScope(profileId, vacancyId);
    if (!safeId(owner) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10)
      throw new TypeError('assessment_claim_invalid');
    const at = this.clock().toISOString();
    const leaseUntil = new Date(Date.parse(at) + this.leaseMs).toISOString();
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE r03_accepted_assessment_queue SET status='outcome_unknown',
        lease_owner=NULL,lease_until=NULL,updated_at=?
        WHERE profile_id=? AND vacancy_id=? AND status='running' AND lease_until<=?`)
        .run(at, profileId, vacancyId, at);
      const rows = this.db.prepare(`SELECT * FROM r03_accepted_assessment_queue
        WHERE profile_id=? AND vacancy_id=? AND
          (status='pending' OR status='deferred' AND retry_at<=?)
        ORDER BY created_at,job_id,resume_id LIMIT ?`).all(profileId, vacancyId, at, limit);
      for (const row of rows) this.db.prepare(`UPDATE r03_accepted_assessment_queue
        SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=?
        WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=? AND status IN ('pending','deferred')`)
        .run(owner, leaseUntil, at, profileId, vacancyId, row.job_id, row.resume_id);
      return rows.map(row => ({ ...row, lease_owner: owner, lease_until: leaseUntil, attempts: row.attempts + 1 }));
    }).immediate();
  }

  finish(row, owner, outcome, assessment = null) {
    const at = this.clock().toISOString();
    return this.db.transaction(() => {
      const current = this.db.prepare(`SELECT * FROM r03_accepted_assessment_queue
        WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`)
        .get(row.profile_id, row.vacancy_id, row.job_id, row.resume_id);
      if (current?.status !== 'running' || current.lease_owner !== owner || current.lease_until <= at ||
          current.input_revision !== row.input_revision) return false;
      const accepted = this.accepted(row.profile_id, row.vacancy_id);
      if (!accepted.includes(row.job_id)) outcome = 'blocked_unaccepted';
      if (outcome === 'completed') {
        if (!validAssessment(assessment)) throw new TypeError('assessment_invalid');
        const snapshot = this.candidateState.resultPage({ profileId: row.profile_id,
          vacancyId: row.vacancy_id, jobId: row.job_id, limit: 1 })?.snapshot;
        const member = this.db.prepare(`SELECT projection FROM real_hh_snapshot_member
          WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`)
          .get(row.profile_id, row.vacancy_id, row.job_id, row.resume_id);
        if (!snapshot || !member || this.candidateState.assessmentInputRevision(snapshot,
            JSON.parse(member.projection)) !== row.input_revision) return false;
        const existing = this.db.prepare(`SELECT input_revision FROM real_hh_assessment
          WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`)
          .get(row.profile_id, row.vacancy_id, row.job_id, row.resume_id);
        if (existing && existing.input_revision !== row.input_revision) return false;
        this.db.prepare(`INSERT OR IGNORE INTO real_hh_assessment
          (profile_id,vacancy_id,job_id,resume_id,input_revision,assessment,assessed_at)
          VALUES(?,?,?,?,?,?,?)`).run(row.profile_id, row.vacancy_id, row.job_id,
          row.resume_id, row.input_revision, JSON.stringify(assessment), at);
      }
      const retryAt = outcome === 'deferred' ? new Date(Date.parse(at) +
        Math.min(15 * 60_000 * 2 ** (current.attempts - 1), 24 * 60 * 60_000)).toISOString() : null;
      this.db.prepare(`UPDATE r03_accepted_assessment_queue
        SET status=?,lease_owner=NULL,lease_until=NULL,retry_at=?,updated_at=?
        WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`)
        .run(outcome, retryAt, at, row.profile_id, row.vacancy_id, row.job_id, row.resume_id);
      return true;
    }).immediate();
  }

  async tick(profileId, vacancyId, owner, limit = 10) {
    const synced = this.sync(profileId, vacancyId);
    const rows = this.claim(profileId, vacancyId, owner, limit);
    const totals = { ...synced, claimed: rows.length, written: 0, deferred: 0,
      blocked: 0, unknown: 0 };
    for (const row of rows) {
      const snapshot = this.candidateState.resultPage({ profileId, vacancyId,
        jobId: row.job_id, limit: 1 })?.snapshot;
      const member = this.db.prepare(`SELECT projection FROM real_hh_snapshot_member
        WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`)
        .get(profileId, vacancyId, row.job_id, row.resume_id);
      if (!snapshot || !member) {
        if (this.finish(row, owner, 'blocked_unaccepted')) totals.blocked++;
        else totals.unknown++;
        continue;
      }
      const currentCriteria = await this.currentCriteriaRevision({ profileId, vacancyId });
      if (currentCriteria !== snapshot.criteriaRevision) {
        if (this.finish(row, owner, 'blocked_criteria_stale')) totals.blocked++;
        else totals.unknown++;
        continue;
      }
      let assessment;
      try {
        assessment = await this.evaluate({ profileId, vacancyId, candidate: JSON.parse(member.projection),
          criteriaRevision: snapshot.criteriaRevision, inputRevision: row.input_revision });
      } catch {
        const outcome = row.attempts >= 3 ? 'blocked_evaluator' : 'deferred';
        if (this.finish(row, owner, outcome)) totals[outcome === 'deferred' ? 'deferred' : 'blocked']++;
        else totals.unknown++;
        continue;
      }
      const afterCriteria = await this.currentCriteriaRevision({ profileId, vacancyId });
      if (afterCriteria !== currentCriteria) {
        if (this.finish(row, owner, 'blocked_criteria_stale')) totals.blocked++;
        else totals.unknown++;
        continue;
      }
      if (this.finish(row, owner, 'completed', assessment)) totals.written++;
      else totals.unknown++;
    }
    return totals;
  }

  statusFor(profileId, vacancyId, jobId, candidateId) {
    this.candidateState.assertScope(profileId, vacancyId);
    const row = this.db.prepare(`SELECT status FROM r03_accepted_assessment_queue
      WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`)
      .get(profileId, vacancyId, jobId, candidateId);
    return row?.status ?? 'pending';
  }
}
