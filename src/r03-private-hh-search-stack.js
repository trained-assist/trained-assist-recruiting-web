import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';
import { createPrivateHhCredentialBroker } from './r03-private-hh-credential.js';
import { createReviewAwareSearchPlan } from './r03-review-aware-search-plan.js';
import { createHhResumeTransport } from './hh-resume-transport.js';
import { createOfflineHhColdSearch } from './hh-cold-search-offline.js';
import { createDurableHhOccurrenceWorker } from './r03-durable-hh-worker.js';
import { SqlitePrivateBaseQueryCache } from './sqlite-private-base-query-cache.js';
import { SqlitePrivateQueryOverrides } from './sqlite-private-query-overrides.js';

// Composition boundary for one private host. Identity, ownership, SQLite,
// query generation, secrets and HTTP are supplied by the host, never by a
// browser request. Construction does not start a timer or make an HH call.
export function createPrivateHhSearchStack({ resolveProfileBinding, isVacancyOwned,
  candidateState, scheduleRepository, generateQueries, encryptionKey,
  clientId, clientSecret, fetchImpl, clock = () => new Date() } = {}) {
  if (typeof resolveProfileBinding !== 'function' || typeof isVacancyOwned !== 'function' ||
      typeof generateQueries !== 'function' || typeof fetchImpl !== 'function' ||
      typeof candidateState?.recordCompletedSearch !== 'function' ||
      typeof scheduleRepository?.claimDueOccurrences !== 'function' || typeof clock !== 'function')
    throw new TypeError('private HH search stack ports required');
  const baseQueryCache = new SqlitePrivateBaseQueryCache({ db: candidateState.db });
  const queryOverrides = new SqlitePrivateQueryOverrides({ db: candidateState.db });
  const loadBasePlan = createPrivateBaseSearchPlan({ resolveProfileBinding, isVacancyOwned,
    generateQueries, queryCache: baseQueryCache, queryOverrides });
  const loadSearchPlan = createReviewAwareSearchPlan({ loadBasePlan, candidateState, generateQueries });
  const credentials = createPrivateHhCredentialBroker({ resolveProfileBinding,
    encryptionKey, clientId, clientSecret, fetchImpl });
  const transport = createHhResumeTransport({
    loadVacancyContext: async (profileId, vacancyId) => {
      const plan = await loadBasePlan(profileId, vacancyId);
      return { profileId, vacancyId, config: plan.atsConfig };
    },
    loadCredential: credentials.loadCredential,
    refreshCredential: credentials.refreshCredential,
    fetchImpl
  });
  const search = createOfflineHhColdSearch({ loadSearchPlan, transport, candidateState, clock });
  const worker = createDurableHhOccurrenceWorker({ scheduleRepository, loadSearchPlan,
    search, candidateState, clock });
  return { loadBasePlan, loadSearchPlan, queryOverrides, search, worker };
}
