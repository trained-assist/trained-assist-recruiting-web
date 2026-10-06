import { fileURLToPath } from 'node:url';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { SqliteColdSearchScheduleRepository } from './sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState } from './sqlite-real-hh-candidate-state.js';
import { SqliteRealHhManualRuns } from './sqlite-real-hh-manual-runs.js';
import { createAcceptedAssessmentStatusReader } from './sqlite-accepted-assessment-queue.js';
import { createServiceLadderChat } from './r03-service-ladder-chat.js';
import { createFreeLadderChat } from './r03-free-ladder-chat.js';
import { createHhAssessmentEvaluator } from './r03-hh-assessment-evaluator.js';
import { createHhQueryGenerator } from './r03-hh-query-generator.js';
import { createPrivateHhSearchStack } from './r03-private-hh-search-stack.js';
import { createR03AccumulatedRealFeedFromStores } from './r03-accumulated-real-feed.js';
import { createR03RealProactiveActions } from './r03-real-proactive-actions.js';
import { createPrivateWebAuth } from './r03-private-web-auth.js';
import { createR03PrivatePromptSettings } from './r03-private-prompt-settings.js';
import { createR03PrivateSeenImport } from './r03-private-seen-import.js';
import { createR03PrivateAiScore } from './r03-private-ai-score.js';
import { createR03PrivateManualCandidate } from './r03-private-manual-candidate.js';
import { loadPrivateHistoricalRead } from './r03-private-historical-read.js';
import { createRecruitingServer } from './server.js';
import { createControlPlaneConnectedAppClient, createRecruitingConnectedAppBff } from './connected-app-bff.js';
import { SqliteConnectedAppBffStore } from './sqlite-connected-app-bff-store.js';
import { createHhResponseRead } from './r01-live-responses.js';
import { createHhResponseDetailRead } from './r01-live-response-detail.js';
import { createHhResponseConversationRead } from './r01-live-response-conversation.js';
import { SqliteResponseConversationAudit } from './sqlite-response-conversation-audit.js';
import { createPrivateVacancyAssignmentRead, createPrivateVacancyAssignmentSave } from './r01-private-vacancy-assignment.js';
import { SqliteAcceptedReportDraftStore } from './sqlite-accepted-report-draft-store.js';
import { createAcceptedReportSourceRead } from './r04-accepted-report-source.js';
import { createAcceptedHhAssessmentReportReader } from './r04-accepted-hh-assessment-reader.js';
import { createHhResponseReportSourceRead } from './r04-hh-response-report-source.js';
import { createHhResponseResumeRead } from './r01-live-response-resume.js';

// Constructing the server makes no provider request or public bind. The owner
// explicitly supplies private config/credentials; the HTTP process owns its
// SQLite handles and closes them with the server.
export function createPrivateWebRuntime({ configFile, secretsDirectory, fetchImpl = globalThis.fetch,
  clock = () => new Date(), publicOrigin = 'https://recruiter-assistant.ru',
  historicalImportConfigFile, historicalReceiptFile, historicalReceiptSha256,
  connectedAppBff = null, connectedBffConfig = null, reportDraftDbPath = null } = {}) {
  if (typeof fetchImpl !== 'function' || typeof clock !== 'function')
    throw new TypeError('private_web_runtime_unavailable');
  if (connectedAppBff !== null && connectedBffConfig !== null)
    throw new TypeError('private_web_auth_modes_conflict');
  if (reportDraftDbPath !== null && (typeof reportDraftDbPath !== 'string' ||
      connectedAppBff === null && connectedBffConfig === null))
    throw new TypeError('private_report_runtime_requires_connected_bff_and_database');
  const historyOptions = [historicalImportConfigFile, historicalReceiptFile, historicalReceiptSha256];
  if (historyOptions.some(value => value !== undefined) &&
      historyOptions.some(value => value === undefined)) throw new TypeError('historical_receipt_binding_required');
  const config = loadPrivateHostConfig(configFile);
  const historicalRead = historicalReceiptFile === undefined ? null : loadPrivateHistoricalRead({
    importConfigFile: historicalImportConfigFile, receiptFile: historicalReceiptFile,
    receiptSha256: historicalReceiptSha256, hostConfig: config });
  let bffStore = null;
  let reportDraftStore = null;
  let conversationAudit = null;
  const legacySecret = connectedAppBff === null && connectedBffConfig === null
    ? loadPrivateHostSecret(secretsDirectory, 'legacy_page_secret') : null;
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
      candidateState: candidates, manualRuns,
      assessmentQueue: createAcceptedAssessmentStatusReader(candidates) });
    const actions = createR03RealProactiveActions({ scheduleRepository: schedules,
      manualRuns, feed, loadSearchPlan: stack.loadSearchPlan,
      isVacancyOwned: config.isVacancyOwned, vacancyFlags: schedules, clock });
    const prompt = createR03PrivatePromptSettings({ loadBasePlan: stack.loadBasePlan,
      queryOverrides: stack.queryOverrides, isVacancyOwned: config.isVacancyOwned, clock });
    const seenImport = createR03PrivateSeenImport({ candidateState: candidates,
      isVacancyOwned: config.isVacancyOwned, clock });
    const readAssessmentPlan = (profileId, vacancyId) =>
      stack.loadBasePlan(profileId, vacancyId, { allowGeneration: false });
    const aiScore = createR03PrivateAiScore({ feed, candidateState: candidates,
      loadBasePlan: stack.loadBasePlan,
      evaluate: createHhAssessmentEvaluator({ loadSearchPlan: readAssessmentPlan,
        chat: createFreeLadderChat({ loadToken: () => loadPrivateHostSecret(secretsDirectory, 'ladder_token'), fetchImpl }) }),
      isVacancyOwned: config.isVacancyOwned, clock });
    const manualCandidate = createR03PrivateManualCandidate({ candidateState: candidates,
      loadBasePlan: stack.loadBasePlan, credentialBroker: stack.credentialBroker,
      isVacancyOwned: config.isVacancyOwned, fetchImpl, clock });
    const liveResponseRead = connectedAppBff !== null || connectedBffConfig !== null
      ? createHhResponseRead({ ...stack.credentialBroker, fetchImpl,
        isVacancyOwned: config.isVacancyOwned, userAgent, clock }) : null;
    const liveResponseDetailRead = connectedAppBff !== null || connectedBffConfig !== null
      ? createHhResponseDetailRead({ ...stack.credentialBroker, fetchImpl,
        isVacancyOwned: config.isVacancyOwned, userAgent, clock }) : null;
    const liveResponseConversationRead = connectedAppBff !== null || connectedBffConfig !== null
      ? createHhResponseConversationRead({ ...stack.credentialBroker, fetchImpl,
        isVacancyOwned: config.isVacancyOwned, userAgent, clock,
        conversationAudit: (conversationAudit = new SqliteResponseConversationAudit({ filename: config.dbPath })) }) : null;
    const liveAssignmentRead = connectedAppBff !== null || connectedBffConfig !== null
      ? createPrivateVacancyAssignmentRead({ resolveProfileBinding: config.resolveProfileBinding,
        isVacancyOwned: config.isVacancyOwned }) : null;
    const liveAssignmentSave = connectedAppBff !== null || connectedBffConfig !== null
      ? createPrivateVacancyAssignmentSave({ resolveProfileBinding: config.resolveProfileBinding,
        isVacancyOwned: config.isVacancyOwned }) : null;
    let acceptedReportSourceRead = null;
    let acceptedHhResponseReportSourceRead = null;
    if (reportDraftDbPath !== null) {
      reportDraftStore = new SqliteAcceptedReportDraftStore({ filename: reportDraftDbPath,
        encryptionKey: loadPrivateHostSecret(secretsDirectory, 'report_drafts_encryption_key') });
      acceptedReportSourceRead = createAcceptedReportSourceRead({ feed, candidateState: candidates,
        loadBasePlan: stack.loadBasePlan, isVacancyOwned: config.isVacancyOwned });
      acceptedHhResponseReportSourceRead = createHhResponseReportSourceRead({
        readResponseDetail: liveResponseDetailRead,
        readResume: createHhResponseResumeRead({ loadCredential: stack.credentialBroker.loadCredential,
          refreshCredential: stack.credentialBroker.refreshCredential, fetchImpl,
          loadBasePlan: stack.loadBasePlan, isVacancyOwned: config.isVacancyOwned, userAgent }),
        loadBasePlan: stack.loadBasePlan,
        loadAcceptedAssessment: createAcceptedHhAssessmentReportReader({ scheduleRepository: schedules,
          candidateState: candidates, manualRuns, isVacancyOwned: config.isVacancyOwned }),
        isVacancyOwned: config.isVacancyOwned,
      });
    }
    if (connectedBffConfig !== null) {
      if (typeof connectedBffConfig !== 'object' ||
          typeof connectedBffConfig.dbPath !== 'string' ||
          typeof connectedBffConfig.issuer !== 'string' ||
          typeof connectedBffConfig.publicOrigin !== 'string' ||
          publicOrigin !== connectedBffConfig.publicOrigin)
        throw new TypeError('private_web_bff_configuration_required');
      const issuer = connectedBffConfig.issuer;
      const client = createControlPlaneConnectedAppClient({ issuer, allowedIssuerOrigins: [issuer],
        serviceKey: loadPrivateHostSecret(secretsDirectory, 'cp_service_key'), fetcher: fetchImpl });
      bffStore = new SqliteConnectedAppBffStore({ filename: connectedBffConfig.dbPath,
        encryptionKey: loadPrivateHostSecret(secretsDirectory, 'bff_encryption_key'),
        clock: () => clock().getTime() });
      connectedAppBff = createRecruitingConnectedAppBff({ issuer, allowedIssuerOrigins: [issuer],
        publicOrigin, redirectUri: `${publicOrigin}/auth/connected/callback`, store: bffStore,
        exchangeCode: client.exchangeCode, introspectToken: client.introspectToken,
        clock: () => clock().getTime(), scopes: ['recruiting.candidateSearch', 'recruiting.responses.read',
          'recruiting.responses.conversation.open'] });
    }
    const auth = connectedAppBff === null ? createPrivateWebAuth({ legacySecret,
      resolveLegacyProfile: config.resolveLegacyProfile,
      isWebProfileMapped: config.isWebProfileMapped, publicOrigin,
      clock: () => clock().getTime() }) : null;
    const server = createRecruitingServer({ realProactiveFeed: feed,
      realProactiveHistoricalRead: historicalRead,
      realProactiveActions: actions, realProactivePrompt: prompt,
      realProactiveSeenImport: seenImport,
      realProactiveAiScore: aiScore,
      realProactiveManualCandidate: manualCandidate,
      liveResponseRead,
      liveResponseDetailRead,
      liveResponseConversationRead,
      liveAssignmentRead,
      liveAssignmentSave,
      acceptedReportSourceRead,
      acceptedHhResponseReportSourceRead,
      acceptedReportDraftStore: reportDraftStore,
      resolveTrustedProfileContext: auth ?? (() => null), connectedAppBff,
      resolveLegacyOpenTab: auth?.resolveLegacyOpenTab ?? null,
      resolveRealVacancyOwnership: (context, vacancyId) => config.isVacancyOwned(context.profileId, vacancyId),
      resolveRealDefaultVacancy: context => {
        const ids = config.vacancyIdsForProfile(context.profileId);
        return ids.length === 1 ? ids[0] : null;
      }, listRealVacancies: context => config.vacancyIdsForProfile(context.profileId),
      privateProactiveOnly: true });
    server.on('close', () => { manualRuns.close(); candidates.close(); schedules.close();
      reportDraftStore?.close(); conversationAudit?.close(); bffStore?.close(); });
    return server;
  } catch (error) {
    manualRuns?.close();
    candidates?.close();
    schedules.close();
    reportDraftStore?.close();
    conversationAudit?.close();
    bffStore?.close();
    throw error;
  }
}

export function parsePrivateWebArgs(args) {
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
    else if (arg === '--connected-bff' && options.connectedBff === undefined) options.connectedBff = true;
    else if (arg === '--cp-issuer' && options.cpIssuer === undefined) options.cpIssuer = args[++i];
    else if (arg === '--public-origin' && options.publicOrigin === undefined) options.publicOrigin = args[++i];
    else if (arg === '--bff-db' && options.bffDbPath === undefined) options.bffDbPath = args[++i];
    else if (arg === '--report-drafts-db' && options.reportDraftDbPath === undefined)
      options.reportDraftDbPath = args[++i];
    else throw new Error('invalid_private_web_arguments');
  }
  if (!options.liveExecution || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new Error('invalid_private_web_arguments');
  if (options.connectedBff) {
    if (!options.cpIssuer || !options.publicOrigin || !options.bffDbPath)
      throw new Error('invalid_private_web_arguments');
    options.connectedBffConfig = { issuer: options.cpIssuer,
      publicOrigin: options.publicOrigin, dbPath: options.bffDbPath };
  } else if (options.cpIssuer || options.bffDbPath || options.publicOrigin)
    throw new Error('invalid_private_web_arguments');
  if (options.reportDraftDbPath !== undefined &&
      (typeof options.reportDraftDbPath !== 'string' || !options.reportDraftDbPath.startsWith('/') || !options.connectedBff))
    throw new Error('invalid_private_web_arguments');
  delete options.connectedBff;
  delete options.cpIssuer;
  delete options.bffDbPath;
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parsePrivateWebArgs(process.argv.slice(2));
    createPrivateWebRuntime(options).listen(options.port, '127.0.0.1', () => {
      process.stdout.write(`${JSON.stringify({ event: 'r03.private_web', status: 'listening', bind: 'loopback' })}\n`);
    });
  } catch {
    process.stdout.write(`${JSON.stringify({ event: 'r03.private_web', status: 'failed', code: 'private_web_unavailable' })}\n`);
    process.exitCode = 78;
  }
}
