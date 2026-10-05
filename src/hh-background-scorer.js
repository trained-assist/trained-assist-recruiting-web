// One bounded pass intended for an external five-minute timer. The evaluator is
// injected; importing this module cannot call HH, an LLM, or a credential store.
export async function runHhBackgroundScoringTick({ state, profileId, vacancyId, evaluate, currentCriteriaRevision, now = () => new Date(), limit = 10 }) {
  if (!state || typeof state.unassessedLatest !== 'function' || typeof state.recordAssessment !== 'function' ||
      typeof evaluate !== 'function' || typeof currentCriteriaRevision !== 'function' || typeof now !== 'function') {
    throw new TypeError('scoring ports required');
  }
  const pending = state.unassessedLatest({ profileId, vacancyId, limit });
  const summary = { pending: pending.length, written: 0, stale: 0, alreadyScored: 0, failed: 0 };
  for (const item of pending) {
    // Criteria are checked on both sides of the await. The production resolver
    // must read the same canonical revision used to create the search snapshot.
    const before = await currentCriteriaRevision({ profileId, vacancyId });
    if (before !== item.snapshot.criteriaRevision) { summary.stale++; continue; }
    let assessment;
    try {
      assessment = await evaluate({ profileId, vacancyId, candidate: item.candidate,
        criteriaRevision: item.snapshot.criteriaRevision, inputRevision: item.inputRevision });
    } catch {
      // Never return evaluator errors: they may embed a resume or prompt.
      summary.failed++;
      continue;
    }
    const after = await currentCriteriaRevision({ profileId, vacancyId });
    if (after !== before) { summary.stale++; continue; }
    let result;
    try {
      result = state.recordAssessment({ profileId, vacancyId, jobId: item.snapshot.jobId,
        candidateId: item.candidate.id, inputRevision: item.inputRevision, assessment, assessedAt: now().toISOString() });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      summary.failed++;
      continue;
    }
    if (result.kind === 'written') summary.written++;
    else if (result.kind === 'already_scored') summary.alreadyScored++;
    else summary.stale++;
  }
  return summary;
}
