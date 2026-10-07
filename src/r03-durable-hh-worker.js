import { createHash } from 'node:crypto';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const jobIdFor = occurrenceId => `hh_occurrence_${createHash('sha256').update(occurrenceId).digest('hex').slice(0, 32)}`;

// The schedule repository owns the atomic due claim and occurrence fence. The
// search runner owns the candidate/seen/snapshot transaction. There is no
// distributed transaction across those effects, so an uncertain finish stays
// quarantined for explicit reconciliation.
export function createDurableHhOccurrenceWorker({ scheduleRepository, loadSearchPlan, search, candidateState, clock = () => new Date(), leaseMs = 5 * 60_000 } = {}) {
  if (typeof scheduleRepository?.claimDueOccurrences !== 'function' || typeof scheduleRepository?.finishOccurrence !== 'function' ||
      typeof loadSearchPlan !== 'function' || typeof search?.run !== 'function' ||
      typeof candidateState?.assessedResultPage !== 'function' || typeof clock !== 'function' ||
      !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('durable HH worker ports required');

  async function tick(workerId) {
    if (!safeId(workerId)) throw new TypeError('valid worker ID required');
    const now = clock().toISOString();
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    const claimed = scheduleRepository.claimDueOccurrences({ now, workerId, leaseUntil });
    const totals = { claimed: claimed.length, completed: 0, rejected: 0, unknown: 0 };
    for (const { schedule, occurrence } of claimed) {
      const jobId = jobIdFor(occurrence.occurrenceId);
      const context = { profileId: schedule.profileId, scopes: ['recruiting.candidateSearch'] };
      const finish = result => scheduleRepository.finishOccurrence(occurrence.occurrenceId, workerId, result, clock().toISOString());
      let plan;
      try { plan = await loadSearchPlan(schedule.profileId, schedule.vacancyId); }
      catch { plan = null; }
      if (!plan || plan.profileId !== schedule.profileId || plan.vacancyId !== schedule.vacancyId ||
          typeof plan.criteriaRevision !== 'string' || !plan.criteriaRevision ||
          typeof plan.queryCache?.revision !== 'string' || !plan.queryCache.revision) {
        if (finish({ status: 'rejected', errorCode: 'search_plan_unavailable', jobId: null })) totals.rejected++;
        else totals.unknown++;
        continue;
      }
      try {
        const result = await search.run({ trustedContext: context, vacancyId: schedule.vacancyId, jobId, source: 'scheduled',
          expectedCriteriaRevision: plan.criteriaRevision, expectedQueryRevision: plan.queryCache.revision });
        const snapshot = result?.snapshot;
        if (result?.status !== 'completed' || snapshot?.profileId !== schedule.profileId ||
            snapshot?.vacancyId !== schedule.vacancyId || snapshot?.jobId !== jobId ||
            snapshot?.source !== 'scheduled' || snapshot?.criteriaRevision !== plan.criteriaRevision) throw new Error('invalid_search_result');
        const projection = { sourceRevision: snapshot.sourceRevision, resultRevision: snapshot.resultRevision,
          resultCount: snapshot.candidateCount, ranking: 'pre_score' };
        if (finish({ status: 'succeeded', criteriaRevision: plan.criteriaRevision, jobId, snapshot: projection })) totals.completed++;
        else totals.unknown++;
      } catch (error) {
        // A plan can change between preflight and the runner's first read. That
        // specific failure precedes provider dispatch; all other errors may
        // have followed a provider call or committed snapshot.
        const preDispatch = error?.code === 'search_plan_unavailable' || error?.code === 'search_scope_denied';
        const status = preDispatch ? 'rejected' : 'outcome_unknown';
        if (finish({ status, criteriaRevision: plan.criteriaRevision, errorCode: preDispatch ? 'search_plan_unavailable' : 'search_outcome_unknown', jobId })) {
          totals[preDispatch ? 'rejected' : 'unknown']++;
        } else totals.unknown++;
      }
    }
    return totals;
  }

  function morningResults(trustedContext, vacancyId, { cursor = null, limit = 50 } = {}) {
    if (!safeId(trustedContext?.profileId) || !trustedContext.scopes?.includes('recruiting.candidateSearch') || !safeId(vacancyId))
      throw new Error('candidate_scope_denied');
    const ownedRows = scheduleRepository.listOccurrences(trustedContext.profileId).filter(row => row.vacancyId === vacancyId);
    const latestRunAt = ownedRows.reduce((latest, row) => row.scheduledAt > latest ? row.scheduledAt : latest, '');
    const rows = ownedRows.filter(row => row.status === 'succeeded' && safeId(row.jobId))
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
    for (const row of rows) {
      const page = candidateState.assessedResultPage({ profileId: trustedContext.profileId, vacancyId, jobId: row.jobId, cursor, limit });
      if (page?.snapshot?.source === 'scheduled' && page.snapshot.jobId === row.jobId)
        return { status: 'completed', freshness: latestRunAt > row.scheduledAt ? 'latest_run_incomplete' : 'latest_completed',
          occurrenceId: row.occurrenceId, scheduledAt: row.scheduledAt, ...page };
    }
    return { status: 'never_run', freshness: latestRunAt ? 'latest_run_incomplete' : 'never_run',
      snapshot: null, items: [], nextCursor: null };
  }

  return { tick, morningResults };
}
