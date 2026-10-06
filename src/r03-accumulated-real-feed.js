import { createHash } from 'node:crypto';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function createR03AccumulatedRealFeed({ scheduleRepository, candidateState, loadAcceptedManualReceipts = () => [] }) {
  if (typeof scheduleRepository?.listOccurrences !== 'function' ||
      typeof candidateState?.acceptedCandidateFeed !== 'function' ||
      typeof candidateState?.updateCandidateOverlay !== 'function' ||
      typeof loadAcceptedManualReceipts !== 'function') throw new TypeError('real feed ports required');

  function scope(trustedContext, vacancyId) {
    if (!safeId(trustedContext?.profileId) || !trustedContext.scopes?.includes('recruiting.candidateSearch') || !safeId(vacancyId))
      throw new Error('candidate_scope_denied');
    return trustedContext.profileId;
  }
  function read(trustedContext, vacancyId) {
    const profileId = scope(trustedContext, vacancyId);
    const occurrences = scheduleRepository.listOccurrences(profileId).filter(row => row.vacancyId === vacancyId);
    const accepted = occurrences.filter(row => row.status === 'succeeded' && safeId(row.jobId) && row.snapshot)
      .filter(row => {
        const page = candidateState.resultPage({ profileId, vacancyId, jobId: row.jobId, limit: 1 });
        return page?.snapshot?.source === 'scheduled' && page.snapshot.resultRevision === row.snapshot.resultRevision &&
          page.snapshot.sourceRevision === row.snapshot.sourceRevision && page.snapshot.candidateCount === row.snapshot.resultCount;
      });
    const manualReceipts = loadAcceptedManualReceipts(profileId, vacancyId);
    if (!Array.isArray(manualReceipts) || manualReceipts.length > 1000) throw new TypeError('invalid_manual_receipts');
    const acceptedManual = manualReceipts.filter(row => safeId(row?.jobId) && row.status === 'succeeded' && row.profileId === profileId &&
      row.vacancyId === vacancyId && typeof row.resultRevision === 'string' && typeof row.sourceRevision === 'string' &&
      Number.isSafeInteger(row.resultCount) && row.resultCount >= 0)
      .filter(row => {
        const page = candidateState.resultPage({ profileId, vacancyId, jobId: row.jobId, limit: 1 });
        return page?.snapshot?.source === 'manual' && page.snapshot.resultRevision === row.resultRevision &&
          page.snapshot.sourceRevision === row.sourceRevision && page.snapshot.candidateCount === row.resultCount;
      });
    const items = candidateState.acceptedCandidateFeed({ profileId, vacancyId,
      acceptedScheduledJobIds: accepted.map(row => row.jobId), acceptedManualJobIds: acceptedManual.map(row => row.jobId) });
    const latestRunAt = occurrences.reduce((latest, row) => row.scheduledAt > latest ? row.scheduledAt : latest, '');
    const latestAcceptedAt = accepted.reduce((latest, row) => row.scheduledAt > latest ? row.scheduledAt : latest, '');
    const hasAcceptedSearch = accepted.length > 0 || acceptedManual.length > 0;
    const freshness = latestRunAt > latestAcceptedAt ? 'latest_run_incomplete' : hasAcceptedSearch ? 'latest_completed' : 'never_run';
    const resultRevision = createHash('sha256').update(JSON.stringify({ profileId, vacancyId, accepted: accepted.map(row => row.jobId),
      acceptedManual: acceptedManual.map(row => row.jobId),
      latestRunAt, items })).digest('hex').slice(0, 24);
    return { status: hasAcceptedSearch ? 'completed' : 'never_run', freshness, total: items.length, resultRevision, items };
  }
  function update(trustedContext, vacancyId, candidateId, command) {
    const profileId = scope(trustedContext, vacancyId);
    if (!safeId(candidateId) || !read(trustedContext, vacancyId).items.some(item => item.id === candidateId))
      throw new Error('candidate_not_in_accepted_vacancy_feed');
    return candidateState.updateCandidateOverlay({ profileId, vacancyId, candidateId, ...command });
  }
  return { read, update };
}

export function createR03AccumulatedRealFeedFromStores({ scheduleRepository, candidateState, manualRuns }) {
  if (typeof manualRuns?.listAcceptedManualReceipts !== 'function' || manualRuns.candidateState !== candidateState)
    throw new TypeError('shared durable manual receipt store required');
  return createR03AccumulatedRealFeed({ scheduleRepository, candidateState,
    loadAcceptedManualReceipts: (profileId, vacancyId) => manualRuns.listAcceptedManualReceipts(profileId, vacancyId) });
}
