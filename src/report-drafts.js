import { createHash } from 'node:crypto';
import { findReportSource, findReportVacancy, projectClientView, renderClientReportHtml } from './report-preview.js';

const revisionOf = number => `report-demo-r${number}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const operationIdOf = (action, reportRef, reportRevision) => `reportop_demo_${hash(JSON.stringify([action, reportRef, reportRevision])).slice(0, 16)}`;
const deniedPublicationAdapter = {
  async publish() { return { allowed: false }; },
  async revoke() { return { allowed: false }; }
};

function publicReport(report) {
  return {
    domainApiVersion: 'v1', reportRef: report.reportRef,
    candidateId: report.candidateId, vacancyId: report.vacancyId,
    sourceRevision: report.sourceRevision, reportRevision: revisionOf(report.revision),
    status: report.status, reviewState: report.reviewState,
    publicationReceipt: report.publication?.receiptId ?? null,
    publicationOperationId: report.publication?.operationId ?? null,
    revocationOperationId: report.publication?.revocationOperationId ?? null,
    clientFields: structuredClone(report.clientFields)
  };
}

export function createReportDrafts({ publicationAdapter = deniedPublicationAdapter } = {}) {
  const reports = new Map();
  const idempotency = new Map();
  const inFlightOperations = new Map();
  const completedOperations = new Map();

  async function runOperation(operationId, operation) {
    if (completedOperations.has(operationId)) return structuredClone(completedOperations.get(operationId));
    if (inFlightOperations.has(operationId)) return inFlightOperations.get(operationId);
    const pending = (async () => {
      const result = await operation();
      if (result.kind === 'published' || result.kind === 'revoked') completedOperations.set(operationId, structuredClone(result));
      return result;
    })();
    inFlightOperations.set(operationId, pending);
    try { return await pending; }
    finally { if (inFlightOperations.get(operationId) === pending) inFlightOperations.delete(operationId); }
  }

  return {
    create(profileId, key, { candidateId, vacancyId, expectedSourceRevision }, currentSourceRevision) {
      const source = findReportSource(candidateId);
      if (!source) return { kind: 'candidate_not_found' };
      if (source.vacancyId !== vacancyId) return { kind: 'candidate_vacancy_mismatch' };
      if (!findReportVacancy(vacancyId)) return { kind: 'vacancy_not_found' };
      if (!currentSourceRevision) return { kind: 'source_revision_unavailable' };
      if (source.sourceRevision !== expectedSourceRevision || currentSourceRevision !== expectedSourceRevision) {
        return { kind: 'stale_source', expected: expectedSourceRevision, current: currentSourceRevision };
      }
      const requestHash = hash(JSON.stringify([candidateId, vacancyId, expectedSourceRevision]));
      const scopeKey = JSON.stringify([profileId, key]);
      const existingRef = idempotency.get(scopeKey);
      if (existingRef) {
        const existing = reports.get(existingRef);
        if (!existing || existing.profileId !== profileId || existing.idempotencyKey !== key || existing.requestHash !== requestHash) return { kind: 'idempotency_conflict' };
        return { kind: 'existing', report: publicReport(existing) };
      }
      const reportRef = `report_demo_${hash(scopeKey).slice(0, 12)}`;
      const refCollision = reports.get(reportRef);
      if (refCollision && (refCollision.profileId !== profileId || refCollision.idempotencyKey !== key)) return { kind: 'idempotency_conflict' };
      const vacancy = findReportVacancy(vacancyId);
      const report = {
        reportRef, profileId, idempotencyKey: key, requestHash,
        candidateId, vacancyId, sourceRevision: expectedSourceRevision,
        revision: 1, status: 'draft', reviewState: 'unreviewed',
        clientFields: projectClientView(source, vacancy), publication: null
      };
      reports.set(reportRef, report);
      idempotency.set(scopeKey, reportRef);
      return { kind: 'created', report: publicReport(report) };
    },
    get(profileId, reportRef) {
      const report = reports.get(reportRef);
      return report?.profileId === profileId ? { kind: report.status === 'revoked' ? 'revoked' : 'found', report: publicReport(report) } : { kind: 'not_found' };
    },
    edit(profileId, reportRef, expectedReportRevision, patch) {
      const report = reports.get(reportRef);
      if (!report || report.profileId !== profileId) return { kind: 'not_found' };
      if (report.status !== 'draft') return { kind: 'not_editable', report: publicReport(report) };
      if (expectedReportRevision !== revisionOf(report.revision)) return { kind: 'stale_report', currentReportRevision: revisionOf(report.revision) };
      report.clientFields = { ...report.clientFields, ...structuredClone(patch) };
      report.revision++;
      report.reviewState = 'unreviewed';
      return { kind: 'updated', report: publicReport(report) };
    },
    review(profileId, reportRef, expectedReportRevision, decision) {
      const report = reports.get(reportRef);
      if (!report || report.profileId !== profileId) return { kind: 'not_found' };
      if (report.status !== 'draft') return { kind: 'not_reviewable', report: publicReport(report) };
      if (expectedReportRevision !== revisionOf(report.revision)) return { kind: 'stale_report', currentReportRevision: revisionOf(report.revision) };
      report.reviewState = decision;
      report.revision++;
      return { kind: 'reviewed', report: publicReport(report) };
    },
    async publish(profileId, reportRef, expectedReportRevision) {
      const report = reports.get(reportRef);
      if (!report || report.profileId !== profileId) return { kind: 'not_found' };
      const operationId = operationIdOf('publish', reportRef, expectedReportRevision);
      if (completedOperations.has(operationId)) return structuredClone(completedOperations.get(operationId));
      if (inFlightOperations.has(operationId)) return inFlightOperations.get(operationId);
      if (report.status !== 'draft') return { kind: 'not_publishable', report: publicReport(report) };
      if (expectedReportRevision !== revisionOf(report.revision)) return { kind: 'stale_report', currentReportRevision: revisionOf(report.revision) };
      if (report.reviewState !== 'approved') return { kind: 'review_required', report: publicReport(report) };
      return runOperation(operationId, async () => {
        let decision;
        try {
          decision = await publicationAdapter.publish({
            operationId, profileId, reportRef, candidateId: report.candidateId, vacancyId: report.vacancyId,
            audience: 'client', sourceRevision: report.sourceRevision,
            reportRevision: revisionOf(report.revision), clientFields: structuredClone(report.clientFields)
          });
        } catch { return { kind: 'publication_outcome_unknown', operationId, report: publicReport(report) }; }
        if (!decision || decision.allowed !== true) return { kind: 'publication_denied', operationId, report: publicReport(report) };
        if (typeof decision.receiptId !== 'string' || !/^publication_demo_[a-f0-9]{12}$/.test(decision.receiptId)) return { kind: 'publication_outcome_unknown', operationId, report: publicReport(report) };
        report.status = 'published';
        report.publication = { receiptId: decision.receiptId, operationId, publishedRevision: revisionOf(report.revision), state: 'published' };
        report.revision++;
        return { kind: 'published', operationId, report: publicReport(report) };
      });
    },
    async revoke(profileId, reportRef, expectedReportRevision) {
      const report = reports.get(reportRef);
      if (!report || report.profileId !== profileId) return { kind: 'not_found' };
      const operationId = operationIdOf('revoke', reportRef, expectedReportRevision);
      if (completedOperations.has(operationId)) return structuredClone(completedOperations.get(operationId));
      if (inFlightOperations.has(operationId)) return inFlightOperations.get(operationId);
      if (report.status !== 'published' || !report.publication) return { kind: 'not_revokeable', report: publicReport(report) };
      if (expectedReportRevision !== revisionOf(report.revision)) return { kind: 'stale_report', currentReportRevision: revisionOf(report.revision) };
      return runOperation(operationId, async () => {
        let decision;
        try {
          decision = await publicationAdapter.revoke({
            operationId, profileId, reportRef, receiptId: report.publication.receiptId,
            publishedRevision: report.publication.publishedRevision
          });
        } catch { return { kind: 'revocation_outcome_unknown', operationId, report: publicReport(report) }; }
        if (!decision || decision.allowed !== true) return { kind: 'revocation_denied', operationId, report: publicReport(report) };
        report.status = 'revoked';
        report.publication = { ...report.publication, revocationOperationId: operationId, state: 'revoked' };
        report.revision++;
        return { kind: 'revoked', operationId, report: publicReport(report) };
      });
    },
    preview(profileId, reportRef) {
      const result = this.get(profileId, reportRef);
      if (result.kind !== 'found') return result;
      const summary = result.report;
      return {
        kind: 'preview',
        body: {
          domainApiVersion: 'v1', mode: 'preview', audience: 'client', previewOnly: true,
          publication: 'not_shared', reportRef: summary.reportRef,
          candidateId: summary.candidateId, vacancyId: summary.vacancyId,
          sourceRevision: summary.sourceRevision, reportRevision: summary.reportRevision,
          status: summary.status, reviewState: summary.reviewState,
          clientView: summary.clientFields,
          html: renderClientReportHtml(summary.clientFields, summary.sourceRevision, 'СИНТЕТИЧЕСКИЙ ПРОСМОТР · НЕ ПУБЛИЧНАЯ ССЫЛКА')
        }
      };
    }
  };
}
