import { createHash } from 'node:crypto';
import { HhColdSearchRunError, createOfflineHhColdSearch } from './hh-cold-search-offline.js';
import { createHhResumeTransport } from './hh-resume-transport.js';
import { createDurableHhOccurrenceWorker } from './r03-durable-hh-worker.js';

export const FULL_DISCOVERY_BUDGET = Object.freeze({ queries: 15, pagesPerQuery: 40,
  requests: 80, rawItems: 3000, perPage: 50, attemptsPerPage: 1,
  assessmentsPerTick: 10 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validPlan = value => safeId(value?.profileId) && safeId(value?.vacancyId) &&
  typeof value.criteriaRevision === 'string' && value.criteriaRevision &&
  typeof value.queryCache?.revision === 'string' && value.queryCache.revision &&
  Array.isArray(value.queryCache.queries) && value.queryCache.queries.length >= 1 &&
  value.queryCache.queries.length <= FULL_DISCOVERY_BUDGET.queries &&
  value.queryCache.queries.every(query => typeof query === 'string' && query.trim() === query &&
    query.length >= 1 && query.length <= 500) &&
  new Set(value.queryCache.queries).size === value.queryCache.queries.length;

// A page-zero probe is evidence for choosing a real-run budget, never a
// substitute for the budgets enforced at dispatch and before snapshot commit.
export function createFullDiscoveryCostPreflight(plan, probes, at = new Date().toISOString()) {
  if (!validPlan(plan) || !Array.isArray(probes) || probes.length !== plan.queryCache.queries.length ||
      !Number.isFinite(Date.parse(at))) throw new TypeError('full_discovery_preflight_invalid');
  const rows = probes.map((probe, index) => {
    if (probe?.queryHash !== hash(plan.queryCache.queries[index]) ||
        !Number.isSafeInteger(probe.found) || probe.found < 0 ||
        !Number.isSafeInteger(probe.pagesAtOne) || probe.pagesAtOne < 0 ||
        probe.found === 0 && probe.pagesAtOne > 1) throw new TypeError('full_discovery_probe_invalid');
    const estimatedPagesAt50 = Math.max(1, Math.ceil(probe.found / FULL_DISCOVERY_BUDGET.perPage));
    return { queryHash: probe.queryHash, found: probe.found,
      pagesAtOne: probe.pagesAtOne, estimatedPagesAt50 };
  });
  const estimatedRequests = rows.reduce((sum, row) => sum + row.estimatedPagesAt50, 0);
  const rawItemUpperBound = rows.reduce((sum, row) => sum + row.found, 0);
  const reason = rows.some(row => row.estimatedPagesAt50 > FULL_DISCOVERY_BUDGET.pagesPerQuery)
    ? 'query_window_exceeds_budget' : estimatedRequests > FULL_DISCOVERY_BUDGET.requests
      ? 'request_budget_exceeded' : rawItemUpperBound > FULL_DISCOVERY_BUDGET.rawItems
        ? 'raw_item_budget_exceeded' : null;
  return { version: 'r03-full-discovery-cost-preflight-v1', status: reason ? 'blocked' : 'ready',
    reason, at, profileId: plan.profileId, vacancyId: plan.vacancyId,
    criteriaRevision: plan.criteriaRevision, queryRevision: plan.queryCache.revision,
    queryHashes: rows.map(row => row.queryHash), queryCount: rows.length,
    estimatedRequests, rawItemUpperBound, budget: { ...FULL_DISCOVERY_BUDGET }, probes: rows };
}

function requireCurrentPreflight(preflight, plan, clock) {
  const now = clock().getTime();
  if (!validPlan(plan) || preflight?.version !== 'r03-full-discovery-cost-preflight-v1' ||
      preflight.status !== 'ready' || preflight.profileId !== plan.profileId ||
      preflight.vacancyId !== plan.vacancyId || preflight.criteriaRevision !== plan.criteriaRevision ||
      preflight.queryRevision !== plan.queryCache.revision ||
      JSON.stringify(preflight.queryHashes) !== JSON.stringify(plan.queryCache.queries.map(hash)) ||
      JSON.stringify(preflight.budget) !== JSON.stringify(FULL_DISCOVERY_BUDGET) ||
      !Number.isFinite(Date.parse(preflight.at)) || now < Date.parse(preflight.at) ||
      now - Date.parse(preflight.at) > 15 * 60_000)
    throw new HhColdSearchRunError('search_budget_pre_dispatch');
}

// This is the same occurrence/search/state path as manual search, but an
// entire HH window must fit the cap. A failure after the first provider call
// leaves the occurrence unknown; the search never commits a partial snapshot.
export function createBudgetedFullHhDiscovery({ scheduleRepository, candidateState,
  loadSearchPlan, loadCredential, loadVacancyContext, fetchImpl, userAgent,
  preflightFor, assessmentQueue, clock = () => new Date() } = {}) {
  if (typeof scheduleRepository?.claimDueOccurrences !== 'function' ||
      typeof candidateState?.recordCompletedSearch !== 'function' ||
      typeof candidateState?.assessedResultPage !== 'function' ||
      typeof loadSearchPlan !== 'function' || typeof loadCredential !== 'function' ||
      typeof loadVacancyContext !== 'function' || typeof fetchImpl !== 'function' ||
      typeof preflightFor !== 'function' || typeof assessmentQueue?.tick !== 'function' ||
      typeof assessmentQueue?.statusFor !== 'function' ||
      typeof clock !== 'function') throw new TypeError('full discovery ports required');
  const search = { async run(request) {
    const profileId = request?.trustedContext?.profileId;
    const vacancyId = request?.vacancyId;
    const plan = await loadSearchPlan(profileId, vacancyId);
    let preflight;
    try { preflight = await preflightFor(profileId, vacancyId); }
    catch { throw new HhColdSearchRunError('search_budget_pre_dispatch'); }
    requireCurrentPreflight(preflight, plan, clock);
    if (FULL_DISCOVERY_BUDGET.requests < plan.queryCache.queries.length)
      throw new HhColdSearchRunError('search_budget_pre_dispatch');
    let requests = 0;
    let rawItems = 0;
    let budgetCode = null;
    const transport = createHhResumeTransport({ loadVacancyContext, loadCredential,
      fetchImpl: async (url, init) => {
        if (requests >= FULL_DISCOVERY_BUDGET.requests) {
          budgetCode = 'provider_budget_exceeded_partial';
          throw new Error(budgetCode);
        }
        requests++;
        return fetchImpl(url, init);
      }, userAgent, pageLimit: FULL_DISCOVERY_BUDGET.pagesPerQuery,
      perPage: FULL_DISCOVERY_BUDGET.perPage,
      maxAttempts: FULL_DISCOVERY_BUDGET.attemptsPerPage, allowPartialWindow: false });
    const bounded = { search: async input => {
      let result;
      try { result = await transport.search(input); }
      catch (error) {
        if (error?.code === 'provider_result_window_exceeded') budgetCode = 'provider_window_partial';
        throw error;
      }
      rawItems += result.items.length;
      if (rawItems > FULL_DISCOVERY_BUDGET.rawItems) {
        budgetCode = 'candidate_budget_exceeded_partial';
        throw new Error(budgetCode);
      }
      if (result.partial) {
        budgetCode = 'provider_window_partial';
        throw new Error(budgetCode);
      }
      return result;
    } };
    try {
      return await createOfflineHhColdSearch({ loadSearchPlan, transport: bounded,
        candidateState, clock }).run(request);
    } catch (error) {
      if (budgetCode) throw new HhColdSearchRunError(budgetCode);
      throw error;
    }
  } };
  const worker = createDurableHhOccurrenceWorker({ scheduleRepository,
    loadSearchPlan, search, candidateState, clock });
  const trustedContext = profileId => ({ profileId, scopes: ['recruiting.candidateSearch'] });
  function morningResults(profileId, vacancyId, options = {}) {
    const morning = worker.morningResults(trustedContext(profileId), vacancyId, options);
    if (morning.status !== 'completed') return { ...morning, assessmentStatus: 'not_applicable',
      assessmentPendingCount: 0, assessmentBlockedCount: 0 };
    let pending = 0;
    let blocked = 0;
    let cursor = null;
    do {
      const page = candidateState.assessedResultPage({ profileId, vacancyId,
        jobId: morning.snapshot.jobId, cursor, limit: 100 });
      if (!page) throw new Error('accepted_snapshot_unavailable');
      for (const item of page.items) if (item.atsScore === null) {
        const status = assessmentQueue.statusFor(profileId, vacancyId, morning.snapshot.jobId, item.id);
        if (['blocked_unaccepted', 'blocked_criteria_stale', 'blocked_evaluator', 'outcome_unknown'].includes(status)) blocked++;
        else pending++;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return { ...morning, assessmentStatus: pending ? 'assessment_pending' : blocked
      ? 'assessment_attention' : 'assessed', assessmentPendingCount: pending,
      assessmentBlockedCount: blocked };
  }
  async function scoreTick(profileId, vacancyId, owner) {
    return assessmentQueue.tick(profileId, vacancyId, owner,
      FULL_DISCOVERY_BUDGET.assessmentsPerTick);
  }
  return { worker, morningResults, scoreTick };
}
