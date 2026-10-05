import { createHash } from 'node:crypto';
import { findReportSource, findReportVacancy, projectClientView, renderClientReportHtml } from './report-preview.js';

const revisionOf = number => `report-demo-r${number}`;
const hash = value => createHash('sha256').update(value).digest('hex');
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
    clientFields: structuredClone(report.clientFields)
  };
}

export function createReportDrafts({ publicationAdapter = deniedPublicationAdapter } = {}) {
  const reports = new Map();
  const idempotency = new Map();

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
      if (report.status !== 'draft') return { kind: 'not_publishable', report: publicReport(report) };
      if (expectedReportRevision !== revisionOf(report.revision)) return { kind: 'stale_report', currentReportRevision: revisionOf(report.revision) };
      if (report.reviewState !== 'approved') return { kind: 'review_required', report: publicReport(report) };
      let decision;
      try {
        decision = await publicationAdapter.publish({
          profileId, reportRef, candidateId: report.candidateId, vacancyId: report.vacancyId,
          audience: 'client', sourceRevision: report.sourceRevision,
          reportRevision: revisionOf(report.revision), clientFields: structuredClone(report.clientFields)
        });
      } catch { return { kind: 'publication_unavailable', report: publicReport(report) }; }
      if (!decision || decision.allowed !== true) return { kind: 'publication_denied', report: publicReport(report) };
      if (typeof decision.receiptId !== 'string' || !/^publication_demo_[a-f0-9]{12}$/.test(decision.receiptId)) return { kind: 'publication_invalid_receipt', report: publicReport(report) };
      report.status = 'published';
      report.publication = { receiptId: decision.receiptId, publishedRevision: revisionOf(report.revision), state: 'published' };
      report.revision++;
      return { kind: 'published', report: publicReport(report) };
    },
    async revoke(profileId, reportRef, expectedReportRevision) {
      const report = reports.get(reportRef);
      if (!report || report.profileId !== profileId) return { kind: 'not_found' };
      if (report.status !== 'published' || !report.publication) return { kind: 'not_revokeable', report: publicReport(report) };
      if (expectedReportRevision !== revisionOf(report.revision)) return { kind: 'stale_report', currentReportRevision: revisionOf(report.revision) };
      let decision;
      try {
        decision = await publicationAdapter.revoke({
          profileId, reportRef, receiptId: report.publication.receiptId,
          publishedRevision: report.publication.publishedRevision
        });
      } catch { return { kind: 'revocation_unavailable', report: publicReport(report) }; }
      if (!decision || decision.allowed !== true) return { kind: 'revocation_denied', report: publicReport(report) };
      report.status = 'revoked';
      report.publication = { ...report.publication, state: 'revoked' };
      report.revision++;
      return { kind: 'revoked', report: publicReport(report) };
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
