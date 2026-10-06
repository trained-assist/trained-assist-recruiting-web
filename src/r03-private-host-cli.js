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
import { runAcceptedMorningScoringTick } from './r03-morning-scoring.js';

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
  let candidates;
  try {
    candidates = new SqliteRealHhCandidateState({ filename: config.dbPath,
      isVacancyOwned: config.isVacancyOwned });
    const active = schedules.listAllSchedules().filter(row => row.enabled);
    if (active.some(row => !config.isVacancyOwned(row.profileId, row.vacancyId)))
      throw new Error('unbound_enabled_schedule');
    const blocked = active.filter(row => row.blockedByUnknownOccurrenceId).length;
    if (mode === 'check') return { mode, status: blocked ? 'degraded' : 'ready',
      enabledScheduleCount: active.length, blockedScheduleCount: blocked };
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
    const evaluate = createHhAssessmentEvaluator({ loadSearchPlan: stack.loadSearchPlan,
      chat: createFreeLadderChat({ loadToken: loadLadderToken, fetchImpl }) });
    const totals = { processed: 0, held: 0, pending: 0, written: 0,
      stale: 0, alreadyScored: 0, failed: 0 };
    for (const schedule of active) {
      try {
        const result = await runAcceptedMorningScoringTick({ worker: stack.worker,
          state: candidates, trustedContext: { profileId: schedule.profileId,
            scopes: ['recruiting.candidateSearch'] }, vacancyId: schedule.vacancyId,
          evaluate, currentCriteriaRevision: async ({ profileId, vacancyId }) =>
            (await stack.loadSearchPlan(profileId, vacancyId)).criteriaRevision,
          now: clock, limit: 10 });
        totals[result.status === 'processed' ? 'processed' : 'held']++;
        for (const field of ['pending', 'written', 'stale', 'alreadyScored', 'failed'])
          totals[field] += result[field];
      } catch { totals.failed++; }
    }
    return { mode, status: totals.failed || blocked ? 'degraded' : 'completed', ...totals };
  } finally {
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
