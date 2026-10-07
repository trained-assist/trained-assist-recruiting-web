import { runHhBackgroundScoringTick } from './hh-background-scorer.js';

// Only the latest snapshot accepted by the occurrence worker is eligible for
// background assessment. A committed snapshot with an unknown occurrence is
// held for reconciliation and must not become an unreviewed morning result.
export async function runAcceptedMorningScoringTick({ worker, state, trustedContext, vacancyId, evaluate,
  currentCriteriaRevision, now, limit = 10 }) {
  if (typeof worker?.morningResults !== 'function' || typeof state?.latestSnapshot !== 'function')
    throw new TypeError('morning scoring ports required');
  const morning = worker.morningResults(trustedContext, vacancyId, { limit: 1 });
  const latest = state.latestSnapshot(trustedContext.profileId, vacancyId);
  if (morning.status !== 'completed' || !latest || morning.snapshot?.jobId !== latest.jobId)
    return { status: 'held', reason: 'no_accepted_latest_snapshot', pending: 0, written: 0, stale: 0, alreadyScored: 0, failed: 0 };
  return { status: 'processed', ...await runHhBackgroundScoringTick({ state, profileId: trustedContext.profileId,
    vacancyId, evaluate, currentCriteriaRevision, now, limit, expectedJobId: latest.jobId }) };
}
