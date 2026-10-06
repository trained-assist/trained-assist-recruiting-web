import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

// Search feedback is owned by the candidate-state DB; query generation is an
// injected provider and its output is cached durably before any HH dispatch.
export function createReviewAwareSearchPlan({ loadBasePlan, candidateState, generateQueries }) {
  if (typeof loadBasePlan !== 'function' || typeof candidateState?.searchFeedback !== 'function' ||
      typeof candidateState?.cachedFeedbackQueries !== 'function' ||
      typeof candidateState?.storeFeedbackQueries !== 'function' || typeof generateQueries !== 'function')
    throw new TypeError('review-aware search plan ports required');
  return async (profileId, vacancyId) => {
    const base = await loadBasePlan(profileId, vacancyId);
    if (base?.profileId !== profileId || base?.vacancyId !== vacancyId ||
        typeof base?.queryCache?.revision !== 'string' || !base.queryCache.revision ||
        !Array.isArray(base.queryCache.queries)) throw new Error('search_plan_unavailable');
    const feedback = candidateState.searchFeedback(profileId, vacancyId);
    const hasFeedback = feedback.comments.length > 0 || feedback.excludedResumeIds.length > 0;
    if (!hasFeedback) return { ...base, excludedResumeIds: [] };
    let queries = base.queryCache.queries;
    if (feedback.comments.length > 0 && base.queryCache.manual !== true) {
      queries = candidateState.cachedFeedbackQueries(profileId, vacancyId, base.queryCache.revision, feedback.revision);
      if (!queries) {
        const generated = await generateQueries({ profileId, vacancyId, atsConfig: base.atsConfig,
          comments: feedback.comments, baseQueries: base.queryCache.queries });
        queries = candidateState.storeFeedbackQueries(profileId, vacancyId, base.queryCache.revision, feedback.revision, generated);
      }
    }
    return { ...base, excludedResumeIds: feedback.excludedResumeIds,
      queryCache: { ...base.queryCache, queries,
        revision: `feedback-${digest([base.queryCache.revision, feedback.revision, queries])}` } };
  };
}
