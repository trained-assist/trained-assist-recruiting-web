import { acceptedRealHhSnapshotIds } from './r03-accumulated-real-feed.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;

/**
 * Resolve only a persisted ATS assessment whose exact mapped input is present
 * in a snapshot with an accepted scheduled/manual receipt. `candidateProjection`
 * comes from the current HH resume response after mapping it with the current
 * base plan. Matching the durable input revision proves that the score belongs
 * to these resume facts and current criteria, rather than just this resume ID.
 */
export function createAcceptedHhAssessmentReportReader({ scheduleRepository, candidateState,
  manualRuns, isVacancyOwned } = {}) {
  if (typeof scheduleRepository?.listOccurrences !== 'function' ||
      typeof candidateState?.assessmentForSnapshot !== 'function' ||
      typeof candidateState?.candidateOverlayFor !== 'function' ||
      typeof manualRuns?.listAcceptedManualReceipts !== 'function' ||
      manualRuns.candidateState !== candidateState || typeof isVacancyOwned !== 'function')
    throw new TypeError('accepted HH report assessment ports required');

  return (profileId, vacancyId, resumeId, { criteriaRevision, resumeRevision, candidateProjection } = {}) => {
    if (![profileId, vacancyId, resumeId].every(value => SAFE_ID.test(value ?? '')) ||
        typeof criteriaRevision !== 'string' || !criteriaRevision || !SHA.test(resumeRevision ?? '') ||
        candidateProjection?.id !== resumeId || candidateProjection?.vacancyId !== vacancyId ||
        !isVacancyOwned(profileId, vacancyId)) return null;

    const accepted = acceptedRealHhSnapshotIds({ scheduleRepository, candidateState,
      loadAcceptedManualReceipts: (owner, vacancy) => manualRuns.listAcceptedManualReceipts(owner, vacancy),
      profileId, vacancyId });
    const ids = [...new Set([...accepted.acceptedScheduledJobIds, ...accepted.acceptedManualJobIds])];
    const matches = [];
    for (const jobId of ids) {
      const result = candidateState.assessmentForSnapshot({ profileId, vacancyId, jobId, candidateId: resumeId });
      if (result.kind !== 'scored' || result.snapshot.criteriaRevision !== criteriaRevision ||
          result.inputRevision !== candidateState.assessmentInputRevision(result.snapshot, candidateProjection)) continue;
      const assessment = result.assessment;
      if (!Number.isFinite(assessment?.atsScore) || assessment.atsScore < 0 || assessment.atsScore > 10 ||
          !['PASS', 'REVIEW', 'WEAK'].includes(assessment.atsTag)) continue;
      const review = candidateState.candidateOverlayFor({ profileId, vacancyId, candidateId: resumeId });
      if (!['active', 'starred'].includes(review.status)) continue;
      matches.push({ profileId, vacancyId, resumeId, resumeRevision, criteriaRevision,
        assessmentRevision: result.inputRevision, atsScore: assessment.atsScore, atsTag: assessment.atsTag,
        reviewStatus: review.status, reviewRevision: review.revision, searchedAt: result.snapshot.searchedAt });
    }
    matches.sort((a, b) => b.searchedAt.localeCompare(a.searchedAt));
    if (!matches.length) return null;
    const { searchedAt: _searchedAt, ...current } = matches[0];
    return current;
  };
}
