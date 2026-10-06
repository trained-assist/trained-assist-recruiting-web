import { fileURLToPath } from 'node:url';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { SqliteColdSearchScheduleRepository } from './sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState } from './sqlite-real-hh-candidate-state.js';
import { SqliteRealHhManualRuns } from './sqlite-real-hh-manual-runs.js';
import { createServiceLadderChat } from './r03-service-ladder-chat.js';
import { createHhQueryGenerator } from './r03-hh-query-generator.js';
import { createPrivateHhSearchStack } from './r03-private-hh-search-stack.js';
import { createR03AccumulatedRealFeedFromStores } from './r03-accumulated-real-feed.js';
import { createR03RealProactiveActions } from './r03-real-proactive-actions.js';
import { createPrivateWebAuth } from './r03-private-web-auth.js';
import { createR03PrivatePromptSettings } from './r03-private-prompt-settings.js';
import { createR03PrivateSeenImport } from './r03-private-seen-import.js';
import { loadPrivateHistoricalRead } from './r03-private-historical-read.js';
import { createRecruitingServer } from './server.js';

// Constructing the server makes no provider request or public bind. The owner
// explicitly supplies private config/credentials; the HTTP process owns its
// SQLite handles and closes them with the server.
export function createPrivateWebRuntime({ configFile, secretsDirectory, fetchImpl = globalThis.fetch,
  clock = () => new Date(), publicOrigin = 'https://recruiter-assistant.ru',
  historicalImportConfigFile, historicalReceiptFile, historicalReceiptSha256 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof clock !== 'function')
    throw new TypeError('private_web_runtime_unavailable');
  const historyOptions = [historicalImportConfigFile, historicalReceiptFile, historicalReceiptSha256];
  if (historyOptions.some(value => value !== undefined) &&
      historyOptions.some(value => value === undefined)) throw new TypeError('historical_receipt_binding_required');
  const config = loadPrivateHostConfig(configFile);
  const historicalRead = historicalReceiptFile === undefined ? null : loadPrivateHistoricalRead({
    importConfigFile: historicalImportConfigFile, receiptFile: historicalReceiptFile,
    receiptSha256: historicalReceiptSha256, hostConfig: config });
  const legacySecret = loadPrivateHostSecret(secretsDirectory, 'legacy_page_secret');
  const encryptionKey = loadPrivateHostSecret(secretsDirectory, 'hh_encryption_key');
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) throw new Error('invalid_private_encryption_key');
  const clientId = loadPrivateHostSecret(secretsDirectory, 'hh_client_id');
  const clientSecret = loadPrivateHostSecret(secretsDirectory, 'hh_client_secret');
  const userAgent = loadPrivateHostSecret(secretsDirectory, 'hh_user_agent');
  const schedules = new SqliteColdSearchScheduleRepository(config.dbPath);
  let candidates;
  let manualRuns;
  try {
    candidates = new SqliteRealHhCandidateState({ filename: config.dbPath,
      isVacancyOwned: config.isVacancyOwned });
    const generateQueries = createHhQueryGenerator({ chat: createServiceLadderChat({
      loadToken: () => loadPrivateHostSecret(secretsDirectory, 'ladder_token'), fetchImpl }) });
    const stack = createPrivateHhSearchStack({ ...config, candidateState: candidates,
      scheduleRepository: schedules, generateQueries, encryptionKey, clientId, clientSecret,
      fetchImpl, userAgent, clock });
    manualRuns = new SqliteRealHhManualRuns({ filename: config.dbPath,
      isVacancyOwned: config.isVacancyOwned, loadSearchPlan: stack.loadSearchPlan,
      search: stack.search, candidateState: candidates, clock });
    const feed = createR03AccumulatedRealFeedFromStores({ scheduleRepository: schedules,
      candidateState: candidates, manualRuns });
    const actions = createR03RealProactiveActions({ scheduleRepository: schedules,
      manualRuns, feed, loadSearchPlan: stack.loadSearchPlan,
      isVacancyOwned: config.isVacancyOwned, vacancyFlags: schedules, clock });
    const prompt = createR03PrivatePromptSettings({ loadBasePlan: stack.loadBasePlan,
      queryOverrides: stack.queryOverrides, isVacancyOwned: config.isVacancyOwned, clock });
    const seenImport = createR03PrivateSeenImport({ candidateState: candidates,
      isVacancyOwned: config.isVacancyOwned, clock });
    const auth = createPrivateWebAuth({ legacySecret,
      resolveLegacyProfile: config.resolveLegacyProfile,
      isWebProfileMapped: config.isWebProfileMapped, publicOrigin,
      clock: () => clock().getTime() });
    const server = createRecruitingServer({ realProactiveFeed: feed,
      realProactiveHistoricalRead: historicalRead,
      realProactiveActions: actions, realProactivePrompt: prompt,
      realProactiveSeenImport: seenImport,
      resolveTrustedProfileContext: auth,
      resolveRealVacancyOwnership: (context, vacancyId) => config.isVacancyOwned(context.profileId, vacancyId),
      resolveRealDefaultVacancy: context => {
        const ids = config.vacancyIdsForProfile(context.profileId);
        return ids.length === 1 ? ids[0] : null;
      }, privateProactiveOnly: true });
    server.on('close', () => { manualRuns.close(); candidates.close(); schedules.close(); });
    return server;
  } catch (error) {
    manualRuns?.close();
    candidates?.close();
    schedules.close();
    throw error;
  }
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live-execution' && options.liveExecution === undefined) options.liveExecution = true;
    else if (arg === '--config' && options.configFile === undefined) options.configFile = args[++i];
    else if (arg === '--secrets' && options.secretsDirectory === undefined) options.secretsDirectory = args[++i];
    else if (arg === '--port' && options.port === undefined) options.port = Number(args[++i]);
    else if (arg === '--historical-import-config' && options.historicalImportConfigFile === undefined)
      options.historicalImportConfigFile = args[++i];
    else if (arg === '--historical-receipt' && options.historicalReceiptFile === undefined)
      options.historicalReceiptFile = args[++i];
    else if (arg === '--historical-receipt-sha256' && options.historicalReceiptSha256 === undefined)
      options.historicalReceiptSha256 = args[++i];
    else throw new Error('invalid_private_web_arguments');
  }
  if (!options.liveExecution || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new Error('invalid_private_web_arguments');
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArgs(process.argv.slice(2));
    createPrivateWebRuntime(options).listen(options.port, '127.0.0.1', () => {
      process.stdout.write(`${JSON.stringify({ event: 'r03.private_web', status: 'listening', bind: 'loopback' })}\n`);
    });
  } catch {
    process.stdout.write(`${JSON.stringify({ event: 'r03.private_web', status: 'failed', code: 'private_web_unavailable' })}\n`);
    process.exitCode = 78;
  }
}
