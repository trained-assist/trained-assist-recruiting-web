import { createHash } from 'node:crypto';
import { mapHhResumePage } from './hh-resume-mapping.js';
import { REAL_HH_RESULT_VERSION } from './sqlite-real-hh-candidate-state.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const has = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

export class HhColdSearchRunError extends Error {
  constructor(code) { super(code); this.name = 'HhColdSearchRunError'; this.code = code; }
}

function validatedPlan(value, profileId, vacancyId, expectedCriteriaRevision, expectedQueryRevision) {
  if (!value || value.profileId !== profileId || value.vacancyId !== vacancyId ||
      typeof value.criteriaRevision !== 'string' || !value.criteriaRevision || value.criteriaRevision !== expectedCriteriaRevision ||
      !value.queryCache || value.queryCache.revision !== expectedQueryRevision ||
      !Array.isArray(value.queryCache.queries) || value.queryCache.queries.length < 1 || value.queryCache.queries.length > 15 ||
      value.queryCache.queries.some(query => typeof query !== 'string' || !query.trim() || query !== query.trim() || query.length > 500) ||
      new Set(value.queryCache.queries).size !== value.queryCache.queries.length ||
      !value.atsConfig || typeof value.atsConfig !== 'object' || !has(value, 'area') ||
      value.feedbackRevision !== undefined && !/^[a-f0-9]{24}$/.test(value.feedbackRevision) ||
      value.excludedResumeIds !== undefined && (!Array.isArray(value.excludedResumeIds) || value.excludedResumeIds.length > 20000 ||
        value.excludedResumeIds.some(id => !safeId(id)) || new Set(value.excludedResumeIds).size !== value.excludedResumeIds.length))
    throw new HhColdSearchRunError('search_plan_unavailable');
  return value;
}

function sourceKey(plan) {
  const key = [plan.criteriaRevision, plan.queryCache.revision, plan.queryCache.queries, plan.area, plan.atsConfig];
  if (plan.excludedResumeIds?.length) key.push([...plan.excludedResumeIds].sort());
  return key;
}

export function createOfflineHhColdSearch({ loadSearchPlan, transport, candidateState, clock = () => new Date() } = {}) {
  if (typeof loadSearchPlan !== 'function' || typeof transport?.search !== 'function' ||
      typeof candidateState?.recordCompletedSearch !== 'function' || typeof candidateState?.latestSnapshot !== 'function' ||
      typeof clock !== 'function') throw new TypeError('offline HH search ports required');
  return {
    async run({ trustedContext, vacancyId, jobId, source, expectedCriteriaRevision, expectedQueryRevision } = {}) {
      const profileId = trustedContext?.profileId;
      if (!safeId(profileId) || !Array.isArray(trustedContext.scopes) || !trustedContext.scopes.includes('recruiting.candidateSearch') ||
          !safeId(vacancyId) || !safeId(jobId) || !['manual', 'scheduled'].includes(source) ||
          typeof expectedCriteriaRevision !== 'string' || !expectedCriteriaRevision ||
          typeof expectedQueryRevision !== 'string' || !expectedQueryRevision) throw new HhColdSearchRunError('search_scope_denied');
      let plan;
      try { plan = validatedPlan(await loadSearchPlan(profileId, vacancyId), profileId, vacancyId, expectedCriteriaRevision, expectedQueryRevision); }
      catch { throw new HhColdSearchRunError('search_plan_unavailable'); }
      const sourceRevision = `hh-search-${hash(sourceKey(plan)).slice(0, 24)}`;
      const previously = candidateState.resultPage?.({ profileId, vacancyId, jobId, limit: 1 });
      if (previously) {
        const snapshot = previously.snapshot;
        if (snapshot.criteriaRevision !== plan.criteriaRevision || snapshot.sourceRevision !== sourceRevision || snapshot.source !== source) throw new HhColdSearchRunError('search_job_conflict');
        return { status: 'completed', snapshot, replayed: true };
      }
      const candidates = new Map();
      const collectedIds = new Set();
      const excluded = new Set(plan.excludedResumeIds ?? []);
      let areas = null;
      for (const query of plan.queryCache.queries) {
        let page;
        try { page = await transport.search({ trustedContext, vacancyId, query, area: plan.area }); }
        catch { throw new HhColdSearchRunError('provider_search_failed'); }
        if (page.profileId !== profileId || page.vacancyId !== vacancyId || !Array.isArray(page.areas) || !Array.isArray(page.items) || page.items.length > 2000 ||
            (areas !== null && JSON.stringify(areas) !== JSON.stringify(page.areas))) throw new HhColdSearchRunError('provider_scope_or_area_mismatch');
        areas ??= page.areas;
        const mappedCandidates = [];
        try {
          for (let offset = 0; offset < page.items.length; offset += 50) {
            const mapped = mapHhResumePage(page.items.slice(offset, offset + 50), plan.atsConfig, vacancyId);
            mappedCandidates.push(...mapped.candidates);
          }
        } catch { throw new HhColdSearchRunError('provider_mapping_failed'); }
        for (const item of page.items) collectedIds.add(item.id);
        for (const candidate of mappedCandidates) if (!excluded.has(candidate.id) && !candidates.has(candidate.id)) candidates.set(candidate.id, candidate);
      }
      let current;
      try { current = validatedPlan(await loadSearchPlan(profileId, vacancyId), profileId, vacancyId, expectedCriteriaRevision, expectedQueryRevision); }
      catch { throw new HhColdSearchRunError('search_plan_stale'); }
      if (hash(sourceKey(current)) !== hash(sourceKey(plan))) throw new HhColdSearchRunError('search_plan_stale');
      const searchedAt = clock().toISOString();
      let snapshot;
      try {
        snapshot = candidateState.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION, profileId, vacancyId, jobId,
          searchedAt, criteriaRevision: plan.criteriaRevision, sourceRevision, source,
          totalCollected: collectedIds.size, candidates: [...candidates.values()],
          ...(plan.feedbackRevision ? { expectedFeedbackRevision: plan.feedbackRevision } : {}) });
      } catch { throw new HhColdSearchRunError('candidate_commit_failed'); }
      return { status: 'completed', snapshot, replayed: false };
    }
  };
}
