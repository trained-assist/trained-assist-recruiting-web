import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { SqliteColdSearchScheduleRepository } from './sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState } from './sqlite-real-hh-candidate-state.js';
import { createServiceLadderChat } from './r03-service-ladder-chat.js';
import { createFreeLadderChat } from './r03-free-ladder-chat.js';
import { createHhQueryGenerator } from './r03-hh-query-generator.js';
import { createPrivateHhSearchStack } from './r03-private-hh-search-stack.js';
import { createHhAssessmentEvaluator } from './r03-hh-assessment-evaluator.js';
import { runPrivateHhMinuteTick } from './r03-private-minute-tick.js';
import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';
import { SqlitePrivateBaseQueryCache } from './sqlite-private-base-query-cache.js';
import { SqlitePrivateQueryOverrides } from './sqlite-private-query-overrides.js';
import { SqliteRealHhManualRuns } from './sqlite-real-hh-manual-runs.js';
import { SqliteAcceptedAssessmentQueue } from './sqlite-accepted-assessment-queue.js';
import { runAcceptedAssessmentWorker } from './r03-accepted-assessment-worker.js';

// Runtime entrypoint for an explicitly staged private host. Check mode performs
// no provider call. Live modes require the caller to opt in and supply secrets.
export async function runPrivateHostMode({ mode, configFile, secretsDirectory = null,
  liveExecution = false, fetchImpl, clock = () => new Date(), workerId = randomUUID() } = {}) {
  if (!['check', 'minute', 'score'].includes(mode) || typeof clock !== 'function' ||
      mode !== 'check' && (!liveExecution || typeof fetchImpl !== 'function' ||
        typeof secretsDirectory !== 'string' || !secretsDirectory))
    throw new TypeError('private_host_mode_unavailable');
  const config = loadPrivateHostConfig(configFile);
  const schedules = new SqliteColdSearchScheduleRepository(config.dbPath);
  let candidates, manualRuns, assessmentQueue;
  try {
    candidates = new SqliteRealHhCandidateState({ filename: config.dbPath,
      isVacancyOwned: config.isVacancyOwned });
    const active = schedules.listAllSchedules().filter(row => row.enabled);
    if (active.some(row => !config.isVacancyOwned(row.profileId, row.vacancyId)))
      throw new Error('unbound_enabled_schedule');
    const blocked = active.filter(row => row.blockedByUnknownOccurrenceId).length;
    if (mode === 'check') return { mode, status: blocked ? 'degraded' : 'ready',
      enabledScheduleCount: active.length, blockedScheduleCount: blocked };
    if (mode === 'score') {
      // ATS needs the private vacancy criteria and ladder token only. It does
      // not open HH credentials, regenerate queries, or run discovery.
      const basePlan = createPrivateBaseSearchPlan({ ...config,
        queryCache: new SqlitePrivateBaseQueryCache({ db: candidates.db }),
        queryOverrides: new SqlitePrivateQueryOverrides({ db: candidates.db }),
        generateQueries: async () => { throw new Error('score_query_generation_denied'); } });
      const loadScoringPlan = (profileId, vacancyId) =>
        basePlan(profileId, vacancyId, { allowGeneration: false });
      const evaluate = createHhAssessmentEvaluator({ loadSearchPlan: loadScoringPlan,
        chat: createFreeLadderChat({ loadToken: () =>
          loadPrivateHostSecret(secretsDirectory, 'ladder_token'), fetchImpl }) });
      manualRuns = new SqliteRealHhManualRuns({ filename: config.dbPath,
        isVacancyOwned: config.isVacancyOwned, candidateState: candidates,
        loadSearchPlan: loadScoringPlan, search: { run: async () => {
          throw new Error('score_search_denied'); } }, clock });
      assessmentQueue = new SqliteAcceptedAssessmentQueue({ filename: config.dbPath,
        candidateState: candidates, scheduleRepository: schedules,
        loadAcceptedManualReceipts: (p, v) => manualRuns.listAcceptedManualReceipts(p, v),
        evaluate, currentCriteriaRevision: async ({ profileId, vacancyId }) =>
          (await loadScoringPlan(profileId, vacancyId)).criteriaRevision, clock });
      const scopes = config.profileIds.flatMap(profileId => config.vacancyIdsForProfile(profileId)
        .map(vacancyId => ({ profileId, vacancyId })));
      return { mode, ...await runAcceptedAssessmentWorker({ queue: assessmentQueue,
        scopes, workerId, clock }) };
    }
    const encryptionKey = loadPrivateHostSecret(secretsDirectory, 'hh_encryption_key');
    if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) throw new Error('invalid_private_encryption_key');
    const clientId = loadPrivateHostSecret(secretsDirectory, 'hh_client_id');
    const clientSecret = loadPrivateHostSecret(secretsDirectory, 'hh_client_secret');
    const userAgent = loadPrivateHostSecret(secretsDirectory, 'hh_user_agent');
    const loadLadderToken = () => loadPrivateHostSecret(secretsDirectory, 'ladder_token');
    const generateQueries = createHhQueryGenerator({ chat: createServiceLadderChat({
      loadToken: loadLadderToken, fetchImpl }) });
    const stack = createPrivateHhSearchStack({ ...config, candidateState: candidates,
      scheduleRepository: schedules, generateQueries, encryptionKey, clientId,
      clientSecret, fetchImpl, userAgent, clock });
    if (mode === 'minute') {
      const result = await runPrivateHhMinuteTick({ worker: stack.worker,
        scheduleRepository: schedules, workerId, clock });
      return { mode, ...result };
    }
  } finally {
    if (assessmentQueue?.db.open) assessmentQueue.close();
    if (manualRuns?.db.open) manualRuns.close();
    if (candidates?.db.open) candidates.close();
    if (schedules.db.open) schedules.close();
  }
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live-execution' && options.liveExecution === undefined) options.liveExecution = true;
    else if (arg === '--mode' && options.mode === undefined) options.mode = args[++i];
    else if (arg === '--config' && options.configFile === undefined) options.configFile = args[++i];
    else if (arg === '--secrets' && options.secretsDirectory === undefined) options.secretsDirectory = args[++i];
    else throw new Error('invalid_private_host_arguments');
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runPrivateHostMode({ ...parseArgs(process.argv.slice(2)), fetchImpl: globalThis.fetch });
    process.stdout.write(`${JSON.stringify({ event: 'r03.private_host', ...result })}\n`);
    if (['degraded', 'lease_lost'].includes(result.status)) process.exitCode = 2;
  } catch {
    process.stdout.write(`${JSON.stringify({ event: 'r03.private_host', status: 'failed', code: 'private_host_unavailable' })}\n`);
    process.exitCode = 78;
  }
}
