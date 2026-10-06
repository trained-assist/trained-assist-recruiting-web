import { SqliteRealHhCandidateState } from './sqlite-real-hh-candidate-state.js';
import { manualJobIdForRun } from './sqlite-real-hh-manual-runs.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const parse = row => row ? JSON.parse(row.payload) : null;
const reasons = new Set(['lease_expired_after_completion', 'operator_verified']);

// Operator-only repair of a committed manual snapshot. No provider port is
// accepted; manual run status and receipt commit in one SQLite transaction.
export class SqliteRealHhManualReconciler {
  constructor({ filename, isOperatorAuthorized = () => false, isVacancyOwned = () => false,
    clock = () => new Date(), onStage = () => {} } = {}) {
    if (typeof isOperatorAuthorized !== 'function' || typeof isVacancyOwned !== 'function' ||
        typeof clock !== 'function' || typeof onStage !== 'function') throw new TypeError('manual reconciliation ports required');
    this.isOperatorAuthorized = isOperatorAuthorized;
    this.isVacancyOwned = isVacancyOwned;
    this.clock = clock;
    this.onStage = onStage;
    this.state = new SqliteRealHhCandidateState({ filename, isVacancyOwned });
    this.db = this.state.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS real_hh_manual_reconciliation_receipts (
      operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE,
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, job_id TEXT NOT NULL,
      operator_id TEXT NOT NULL, payload TEXT NOT NULL
    )`);
    this.byOperation = this.db.prepare('SELECT payload FROM real_hh_manual_reconciliation_receipts WHERE operation_id=?');
    this.byRun = this.db.prepare('SELECT payload FROM real_hh_manual_reconciliation_receipts WHERE run_id=?');
    this.run = this.db.prepare('SELECT profile_id, vacancy_id, status, payload FROM real_hh_manual_run WHERE run_id=?');
    this.updateRun = this.db.prepare(`UPDATE real_hh_manual_run SET status='completed', lease_until=NULL, payload=?
      WHERE run_id=? AND profile_id=? AND vacancy_id=? AND status='outcome_unknown'`);
    this.writeReceipt = this.db.prepare(`INSERT INTO real_hh_manual_reconciliation_receipts
      (operation_id,run_id,profile_id,vacancy_id,job_id,operator_id,payload) VALUES(?,?,?,?,?,?,?)`);
  }

  close() { this.state.close(); }

  reconcile({ operator, profileId, vacancyId, runId, jobId, operationId,
    expectedCriteriaRevision, expectedSourceRevision, expectedResultRevision,
    expectedResultCount, reasonCode } = {}) {
    if (!safeId(operator?.id) || ![profileId, vacancyId, runId, jobId, operationId].every(safeId) ||
        typeof expectedCriteriaRevision !== 'string' || !expectedCriteriaRevision ||
        typeof expectedSourceRevision !== 'string' || !expectedSourceRevision ||
        !/^[a-f0-9]{24}$/.test(expectedResultRevision ?? '') ||
        !Number.isSafeInteger(expectedResultCount) || expectedResultCount < 0 || !reasons.has(reasonCode))
      return { kind: 'invalid_command' };
    if (!this.isOperatorAuthorized(operator, profileId) || !this.isVacancyOwned(profileId, vacancyId)) return { kind: 'denied' };
    const command = { operatorId: operator.id, profileId, vacancyId, runId, jobId, operationId,
      expectedCriteriaRevision, expectedSourceRevision, expectedResultRevision, expectedResultCount, reasonCode };
    return this.db.transaction(() => {
      const prior = parse(this.byOperation.get(operationId));
      if (prior) return Object.entries(command).every(([key, value]) => prior.command[key] === value)
        ? { kind: 'replayed', receipt: prior } : { kind: 'operation_conflict' };
      if (this.byRun.get(runId)) return { kind: 'run_already_reconciled' };
      const stored = this.run.get(runId);
      const run = parse(stored);
      if (!run || stored.profile_id !== profileId || stored.vacancy_id !== vacancyId ||
          run.profileId !== profileId || run.vacancyId !== vacancyId) return { kind: 'not_found' };
      if (stored.status !== 'outcome_unknown' || run.status !== 'outcome_unknown') return { kind: 'run_not_unknown' };
      if (run.runId !== runId || run.jobId !== jobId || jobId !== manualJobIdForRun(runId) ||
          run.criteriaRevision !== expectedCriteriaRevision ||
          run.sourceRevision && run.sourceRevision !== expectedSourceRevision ||
          run.resultRevision && run.resultRevision !== expectedResultRevision)
        return { kind: 'binding_conflict' };
      const snapshot = this.state.resultPage({ profileId, vacancyId, jobId, limit: 1 })?.snapshot;
      if (!snapshot) return { kind: 'snapshot_not_found' };
      if (snapshot.profileId !== profileId || snapshot.vacancyId !== vacancyId || snapshot.jobId !== jobId ||
          snapshot.source !== 'manual' || snapshot.criteriaRevision !== expectedCriteriaRevision ||
          snapshot.sourceRevision !== expectedSourceRevision) return { kind: 'snapshot_binding_conflict' };
      if (snapshot.resultRevision !== expectedResultRevision || snapshot.candidateCount !== expectedResultCount)
        return { kind: 'result_conflict' };
      const reconciledAt = this.clock().toISOString();
      if (!Number.isFinite(Date.parse(run.startedAt)) || snapshot.searchedAt < run.startedAt || snapshot.searchedAt > reconciledAt)
        return { kind: 'snapshot_time_conflict' };
      const priorErrorCode = run.errorCode;
      Object.assign(run, { status: 'completed', phase: 'completed', pagesCompleted: run.totalPages,
        resultCount: snapshot.candidateCount, sourceRevision: snapshot.sourceRevision,
        resultRevision: snapshot.resultRevision, errorCode: null, leaseUntil: null,
        updatedAt: reconciledAt, finishedAt: reconciledAt,
        reconciledAt, reconciliationOperationId: operationId });
      if (this.updateRun.run(JSON.stringify(run), runId, profileId, vacancyId).changes !== 1)
        throw new Error('manual_reconciliation_race');
      this.onStage('manual_run_resolved');
      const receipt = { receiptVersion: 'real-hh-manual-v1', command, priorStatus: 'outcome_unknown',
        priorErrorCode, searchedAt: snapshot.searchedAt, reconciledAt,
        resultRevision: snapshot.resultRevision, candidateCount: snapshot.candidateCount };
      this.writeReceipt.run(operationId, runId, profileId, vacancyId, jobId, operator.id, JSON.stringify(receipt));
      this.onStage('audit_receipt');
      return { kind: 'reconciled', receipt };
    }).immediate();
  }
}
