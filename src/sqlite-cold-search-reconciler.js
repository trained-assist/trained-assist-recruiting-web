import { createHash } from 'node:crypto';
import { createCandidateState } from './candidate-state.js';
import { SqliteCandidateStateStore } from './sqlite-candidate-state.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const isoUtc = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const reasonCodes = new Set(['state_commit_failed', 'lease_expired_after_completion', 'operator_verified']);
const parse = row => row ? JSON.parse(row.payload) : null;

// Offline operator-only repair. No HTTP/MCP route or provider is imported.
// It reads a completed durable job and commits state, occurrence and receipt
// on the same SQLite connection under one BEGIN IMMEDIATE transaction.
export class SqliteColdSearchReconciler {
  constructor({ filename, isOperatorAuthorized = () => false, isVacancyOwned = () => false, clock = () => new Date(), onStage = () => {} }) {
    if (typeof isOperatorAuthorized !== 'function' || typeof isVacancyOwned !== 'function' || typeof clock !== 'function' || typeof onStage !== 'function') throw new TypeError('valid reconciliation dependencies are required');
    this.isOperatorAuthorized = isOperatorAuthorized;
    this.isVacancyOwned = isVacancyOwned;
    this.clock = clock;
    this.onStage = onStage;
    this.stateStore = new SqliteCandidateStateStore({ filename });
    this.db = this.stateStore.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cold_search_reconciliation_receipts (
      operation_id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE,
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL,
      job_id TEXT NOT NULL, operator_id TEXT NOT NULL,
      payload TEXT NOT NULL
    )`);
    this.byOperation = this.db.prepare('SELECT payload FROM cold_search_reconciliation_receipts WHERE operation_id = ?');
    this.byOccurrence = this.db.prepare('SELECT payload FROM cold_search_reconciliation_receipts WHERE occurrence_id = ?');
    this.job = this.db.prepare('SELECT profile_id, idempotency_key, status, payload FROM candidate_search_jobs WHERE job_id = ?');
    this.occurrence = this.db.prepare('SELECT profile_id, status, payload FROM cold_search_occurrences WHERE occurrence_id = ?');
    this.schedule = this.db.prepare('SELECT profile_id, blocked_by_unknown_occurrence_id, payload FROM cold_search_schedules WHERE schedule_id = ?');
    this.writeOccurrence = this.db.prepare('UPDATE cold_search_occurrences SET status = ?, payload = ? WHERE occurrence_id = ? AND status = ?');
    this.writeSchedule = this.db.prepare('UPDATE cold_search_schedules SET blocked_by_unknown_occurrence_id = NULL, payload = ? WHERE schedule_id = ? AND blocked_by_unknown_occurrence_id = ?');
    this.writeReceipt = this.db.prepare(`INSERT INTO cold_search_reconciliation_receipts
      (operation_id, occurrence_id, profile_id, vacancy_id, job_id, operator_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.candidateState = createCandidateState({ store: this.stateStore, isVacancyOwned });
  }

  close() { this.stateStore.close(); }

  reconcile({ operator, profileId, vacancyId, occurrenceId, jobId, operationId, expectedCriteriaRevision, expectedSourceRevision, expectedResultRevision, reasonCode }) {
    if (!operator || !safeId(operator.id) || !safeId(profileId) || !safeId(vacancyId) || !safeId(occurrenceId) || !safeId(jobId) ||
        !safeId(operationId) || typeof expectedCriteriaRevision !== 'string' || !expectedCriteriaRevision ||
        typeof expectedSourceRevision !== 'string' || !expectedSourceRevision || !/^[a-f0-9]{16}$/.test(expectedResultRevision ?? '') ||
        !reasonCodes.has(reasonCode)) return { kind: 'invalid_command' };
    if (!this.isOperatorAuthorized(operator, profileId) || !this.isVacancyOwned(profileId, vacancyId)) return { kind: 'denied' };
    const command = { operatorId: operator.id, profileId, vacancyId, occurrenceId, jobId, operationId,
      expectedCriteriaRevision, expectedSourceRevision, expectedResultRevision, reasonCode };
    return this.db.transaction(() => {
      const existing = parse(this.byOperation.get(operationId));
      if (existing) return Object.entries(command).every(([key, value]) => existing.command[key] === value)
        ? { kind: 'replayed', receipt: existing } : { kind: 'operation_conflict' };
      if (this.byOccurrence.get(occurrenceId)) return { kind: 'occurrence_already_reconciled' };

      const occurrenceRow = this.occurrence.get(occurrenceId);
      const occurrence = parse(occurrenceRow);
      if (!occurrence || occurrenceRow.profile_id !== profileId || occurrence.profileId !== profileId || occurrence.vacancyId !== vacancyId) return { kind: 'not_found' };
      if (occurrenceRow.status !== 'outcome_unknown' || occurrence.status !== 'outcome_unknown') return { kind: 'occurrence_not_unknown' };
      if (occurrence.jobId && occurrence.jobId !== jobId || occurrence.criteriaRevision && occurrence.criteriaRevision !== expectedCriteriaRevision) return { kind: 'binding_conflict' };
      const scheduleRow = this.schedule.get(occurrence.scheduleId);
      const schedule = parse(scheduleRow);
      if (!schedule || scheduleRow.profile_id !== profileId || schedule.profileId !== profileId || schedule.vacancyId !== vacancyId ||
          schedule.blockedByUnknownOccurrenceId !== occurrenceId || scheduleRow.blocked_by_unknown_occurrence_id !== occurrenceId) return { kind: 'schedule_conflict' };

      const jobRow = this.job.get(jobId);
      const job = parse(jobRow);
      const key = `schedule:${occurrenceId}`;
      const expectedJobId = `search_demo_${digest(JSON.stringify([profileId, key])).slice(0, 12)}`;
      if (!job || !jobRow || jobRow.profile_id !== profileId || job.profileId !== profileId || jobId !== expectedJobId ||
          job.jobId !== jobId || jobRow.idempotency_key !== key || job.idempotencyKey !== key) return { kind: 'job_binding_conflict' };
      if (jobRow.status !== 'completed' || job.status !== 'completed' || !isoUtc(job.completedAt) || !Array.isArray(job.items)) return { kind: 'job_not_completed' };
      if (!job.criteria || !Array.isArray(job.criteria.keywords) || !Array.isArray(job.criteria.regions) ||
          job.requestHash !== digest(JSON.stringify({ vacancyId: job.vacancyId, criteriaRevision: job.criteriaRevision,
            criteria: { keywords: [...job.criteria.keywords], regions: [...job.criteria.regions] } }))) return { kind: 'job_request_conflict' };
      if (job.vacancyId !== vacancyId || job.criteriaRevision !== expectedCriteriaRevision || job.sourceRevision !== expectedSourceRevision ||
          job.items.some(item => item.vacancyId !== vacancyId)) return { kind: 'binding_conflict' };
      const resultRevision = digest(`${jobId}|${job.sourceRevision}|${job.items.map(item => item.candidateRef).join(',')}`).slice(0, 16);
      if (resultRevision !== expectedResultRevision) return { kind: 'result_revision_conflict' };

      const previous = this.stateStore.read(profileId).snapshotsByVacancy[vacancyId]?.find(item => item.jobId === jobId) ?? null;
      if (previous && (previous.searchedAt !== job.completedAt || previous.source !== 'scheduled' ||
          previous.criteriaRevision !== expectedCriteriaRevision || previous.sourceRevision !== expectedSourceRevision ||
          JSON.stringify(previous.candidateRefs) !== JSON.stringify(job.items.map(item => item.candidateRef)))) return { kind: 'snapshot_conflict' };
      const snapshot = this.candidateState.recordSearch({ profileId, vacancyId, jobId, searchedAt: job.completedAt,
        criteriaRevision: job.criteriaRevision, sourceRevision: job.sourceRevision, source: 'scheduled',
        candidates: job.items, totalCollected: job.items.length });
      this.onStage('candidate_snapshot');

      const reconciledAt = this.clock().toISOString();
      if (!isoUtc(reconciledAt)) throw new Error('invalid_reconciliation_clock');
      const priorErrorCode = occurrence.errorCode;
      occurrence.status = 'succeeded';
      occurrence.errorCode = null;
      occurrence.jobId = jobId;
      occurrence.criteriaRevision = job.criteriaRevision;
      occurrence.reconciledAt = reconciledAt;
      occurrence.reconciliationOperationId = operationId;
      occurrence.snapshot = { sourceRevision: job.sourceRevision, resultRevision, resultCount: job.items.length, ranking: 'provider_order_unranked' };
      if (this.writeOccurrence.run('succeeded', JSON.stringify(occurrence), occurrenceId, 'outcome_unknown').changes !== 1) throw new Error('occurrence_reconciliation_race');
      schedule.blockedByUnknownOccurrenceId = null;
      if (this.writeSchedule.run(JSON.stringify(schedule), schedule.scheduleId, occurrenceId).changes !== 1) throw new Error('schedule_reconciliation_race');
      this.onStage('occurrence_resolved');

      const receipt = { receiptVersion: 'v1', command, jobCompletedAt: job.completedAt, reconciledAt,
        priorStatus: 'outcome_unknown', priorErrorCode, snapshotJobId: snapshot.jobId,
        snapshotNewCount: snapshot.newCount, resultRevision, materialized: !previous };
      this.writeReceipt.run(operationId, occurrenceId, profileId, vacancyId, jobId, operator.id, JSON.stringify(receipt));
      this.onStage('audit_receipt');
      return { kind: 'reconciled', receipt };
    }).immediate();
  }
}
