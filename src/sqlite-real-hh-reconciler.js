import { SqliteRealHhCandidateState } from './sqlite-real-hh-candidate-state.js';
import { hhJobIdForOccurrence } from './r03-durable-hh-worker.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const parse = row => row ? JSON.parse(row.payload) : null;
const reasons = new Set(['lease_expired_after_completion', 'operator_verified']);

// Offline, operator-only repair of a snapshot already committed by the real
// HH runner. It never calls the search transport or re-materializes candidates.
export class SqliteRealHhReconciler {
  constructor({ filename, isOperatorAuthorized = () => false, isVacancyOwned = () => false,
    clock = () => new Date(), onStage = () => {} } = {}) {
    if (typeof isOperatorAuthorized !== 'function' || typeof isVacancyOwned !== 'function' ||
        typeof clock !== 'function' || typeof onStage !== 'function') throw new TypeError('real HH reconciliation ports required');
    this.isOperatorAuthorized = isOperatorAuthorized;
    this.isVacancyOwned = isVacancyOwned;
    this.clock = clock;
    this.onStage = onStage;
    this.state = new SqliteRealHhCandidateState({ filename, isVacancyOwned });
    this.db = this.state.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS real_hh_reconciliation_receipts (
      operation_id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE,
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, job_id TEXT NOT NULL,
      operator_id TEXT NOT NULL, payload TEXT NOT NULL
    )`);
    this.byOperation = this.db.prepare('SELECT payload FROM real_hh_reconciliation_receipts WHERE operation_id = ?');
    this.byOccurrence = this.db.prepare('SELECT payload FROM real_hh_reconciliation_receipts WHERE occurrence_id = ?');
    this.occurrence = this.db.prepare('SELECT profile_id, status, payload FROM cold_search_occurrences WHERE occurrence_id = ?');
    this.schedule = this.db.prepare('SELECT profile_id, blocked_by_unknown_occurrence_id, payload FROM cold_search_schedules WHERE schedule_id = ?');
    this.writeOccurrence = this.db.prepare('UPDATE cold_search_occurrences SET status = ?, payload = ? WHERE occurrence_id = ? AND status = ?');
    this.writeSchedule = this.db.prepare('UPDATE cold_search_schedules SET blocked_by_unknown_occurrence_id = NULL, payload = ? WHERE schedule_id = ? AND blocked_by_unknown_occurrence_id = ?');
    this.writeReceipt = this.db.prepare(`INSERT INTO real_hh_reconciliation_receipts
      (operation_id, occurrence_id, profile_id, vacancy_id, job_id, operator_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  }

  close() { this.state.close(); }

  reconcile({ operator, profileId, vacancyId, occurrenceId, jobId, operationId,
    expectedCriteriaRevision, expectedSourceRevision, expectedResultRevision, reasonCode } = {}) {
    if (!safeId(operator?.id) || ![profileId, vacancyId, occurrenceId, jobId, operationId].every(safeId) ||
        typeof expectedCriteriaRevision !== 'string' || !expectedCriteriaRevision ||
        typeof expectedSourceRevision !== 'string' || !expectedSourceRevision ||
        !/^[a-f0-9]{24}$/.test(expectedResultRevision ?? '') || !reasons.has(reasonCode)) return { kind: 'invalid_command' };
    if (!this.isOperatorAuthorized(operator, profileId) || !this.isVacancyOwned(profileId, vacancyId)) return { kind: 'denied' };
    const command = { operatorId: operator.id, profileId, vacancyId, occurrenceId, jobId, operationId,
      expectedCriteriaRevision, expectedSourceRevision, expectedResultRevision, reasonCode };
    return this.db.transaction(() => {
      const prior = parse(this.byOperation.get(operationId));
      if (prior) return Object.entries(command).every(([key, value]) => prior.command[key] === value)
        ? { kind: 'replayed', receipt: prior } : { kind: 'operation_conflict' };
      if (this.byOccurrence.get(occurrenceId)) return { kind: 'occurrence_already_reconciled' };
      const row = this.occurrence.get(occurrenceId);
      const occurrence = parse(row);
      if (!occurrence || row.profile_id !== profileId || occurrence.profileId !== profileId || occurrence.vacancyId !== vacancyId) return { kind: 'not_found' };
      if (row.status !== 'outcome_unknown' || occurrence.status !== 'outcome_unknown') return { kind: 'occurrence_not_unknown' };
      if (jobId !== hhJobIdForOccurrence(occurrenceId) || occurrence.jobId && occurrence.jobId !== jobId ||
          occurrence.criteriaRevision && occurrence.criteriaRevision !== expectedCriteriaRevision) return { kind: 'binding_conflict' };
      const scheduleRow = this.schedule.get(occurrence.scheduleId);
      const schedule = parse(scheduleRow);
      if (!schedule || scheduleRow.profile_id !== profileId || schedule.profileId !== profileId ||
          schedule.vacancyId !== vacancyId || schedule.legacyJobId !== occurrence.legacyJobId ||
          scheduleRow.blocked_by_unknown_occurrence_id !== occurrenceId || schedule.blockedByUnknownOccurrenceId !== occurrenceId)
        return { kind: 'schedule_conflict' };
      const page = this.state.resultPage({ profileId, vacancyId, jobId, limit: 1 });
      const snapshot = page?.snapshot;
      if (!snapshot) return { kind: 'snapshot_not_found' };
      if (snapshot.jobId !== jobId || snapshot.profileId !== profileId || snapshot.vacancyId !== vacancyId ||
          snapshot.source !== 'scheduled' || snapshot.criteriaRevision !== expectedCriteriaRevision ||
          snapshot.sourceRevision !== expectedSourceRevision) return { kind: 'snapshot_binding_conflict' };
      if (snapshot.resultRevision !== expectedResultRevision) return { kind: 'result_revision_conflict' };
      if (!Number.isFinite(Date.parse(occurrence.startedAt)) || snapshot.searchedAt < occurrence.startedAt)
        return { kind: 'snapshot_time_conflict' };
      const reconciledAt = this.clock().toISOString();
      if (snapshot.searchedAt > reconciledAt) return { kind: 'snapshot_time_conflict' };
      const priorErrorCode = occurrence.errorCode;
      occurrence.status = 'succeeded';
      occurrence.errorCode = null;
      occurrence.criteriaRevision = snapshot.criteriaRevision;
      occurrence.jobId = jobId;
      occurrence.snapshot = { sourceRevision: snapshot.sourceRevision, resultRevision: snapshot.resultRevision,
        resultCount: snapshot.candidateCount, ranking: 'pre_score' };
      occurrence.reconciledAt = reconciledAt;
      occurrence.reconciliationOperationId = operationId;
      if (this.writeOccurrence.run('succeeded', JSON.stringify(occurrence), occurrenceId, 'outcome_unknown').changes !== 1)
        throw new Error('real_hh_occurrence_reconciliation_race');
      schedule.blockedByUnknownOccurrenceId = null;
      if (this.writeSchedule.run(JSON.stringify(schedule), schedule.scheduleId, occurrenceId).changes !== 1)
        throw new Error('real_hh_schedule_reconciliation_race');
      this.onStage('occurrence_resolved');
      const receipt = { receiptVersion: 'real-hh-v1', command, priorStatus: 'outcome_unknown', priorErrorCode,
        searchedAt: snapshot.searchedAt, reconciledAt, resultRevision: snapshot.resultRevision,
        candidateCount: snapshot.candidateCount, materialized: false };
      this.writeReceipt.run(operationId, occurrenceId, profileId, vacancyId, jobId, operator.id, JSON.stringify(receipt));
      this.onStage('audit_receipt');
      return { kind: 'reconciled', receipt };
    }).immediate();
  }
}
