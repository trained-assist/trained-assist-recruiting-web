import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { privateDirectory, readPrivateJson } from './r03-private-legacy-archive.js';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';
import { createPrivateHhCredentialBroker } from './r03-private-hh-credential.js';
import { createHhResumeTransport } from './hh-resume-transport.js';
import { FULL_DISCOVERY_BUDGET, createFullDiscoveryCostPreflight } from './r03-full-discovery-budget.js';

const absolute = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SAFE_PROVIDER_CODES = new Set([
  'provider_unavailable', 'provider_invalid_response', 'provider_unauthorized',
  'provider_forbidden', 'provider_error', 'provider_result_window_exceeded',
  'provider_page_count_changed', 'credential_unavailable', 'vacancy_context_unavailable',
  'profile_denied', 'vacancy_invalid', 'query_invalid'
]);
const makeFailure = ({ phase, reason = 'operation_failed', httpStatus = null,
  providerRequestCount = 0 } = {}) => {
  const error = new Error('private_full_cost_preflight_unavailable');
  error.safeDiagnostic = { phase, reason, httpStatus, providerRequestCount };
  return error;
};

// Read-only page-zero HH probes. The receipt expires after fifteen minutes;
// actual dispatch must enforce its own budgets because HH counts can change.
export async function runPrivateFullCostPreflight({ hostConfigFile, stageReceiptFile,
  secretsDirectory, outputFile, profileId, vacancyId, execute = false,
  fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  let requests = 0;
  let phase = 'input_validation';
  const fail = (reason = 'precondition_failed', httpStatus = null) => {
    throw makeFailure({ phase, reason, httpStatus, providerRequestCount: requests });
  };
  try {
    if (!execute || ![hostConfigFile, stageReceiptFile, secretsDirectory, outputFile].every(absolute) ||
        !safeId(profileId) || !safeId(vacancyId) || typeof fetchImpl !== 'function' ||
        typeof clock !== 'function' || existsSync(outputFile)) fail();
    phase = 'output_directory';
    privateDirectory(dirname(outputFile));
    phase = 'host_binding';
    const host = loadPrivateHostConfig(hostConfigFile);
    if (!host.isVacancyOwned(profileId, vacancyId)) fail('profile_vacancy_binding_invalid');
    phase = 'stage_receipt';
    const stage = readPrivateJson(stageReceiptFile, 1024 * 1024);
    if (stage?.version !== 'r03-private-schedule-stage-v1' || stage.status !== 'disposable_only' ||
        stage.sourceDbPath !== host.dbPath || stage.imported !== 11 ||
        stage.unknownQuarantined !== 8 || stage.enabled !== 0) fail('stage_receipt_invalid');
    phase = 'query_plan';
    const loadPlan = createPrivateBaseSearchPlan({ resolveProfileBinding: host.resolveProfileBinding,
      isVacancyOwned: host.isVacancyOwned });
    const plan = await loadPlan(profileId, vacancyId, { allowGeneration: false });
    if (plan.queryCache.pendingGeneration || !plan.queryCache.queries.length ||
        plan.queryCache.queries.length > FULL_DISCOVERY_BUDGET.queries) fail('query_plan_invalid');
    phase = 'credential_setup';
    const encryptionKey = loadPrivateHostSecret(secretsDirectory, 'hh_encryption_key');
    if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) fail('credential_key_invalid');
    const credentials = createPrivateHhCredentialBroker({ resolveProfileBinding: host.resolveProfileBinding,
      encryptionKey, fetchImpl });
    await credentials.loadCredential(profileId);
    const transport = createHhResumeTransport({
      loadVacancyContext: async (p, v) => ({ profileId: p, vacancyId: v, config: plan.atsConfig }),
      loadCredential: credentials.loadCredential,
      fetchImpl: async (url, init) => {
        const parsed = new URL(url);
        if (++requests > FULL_DISCOVERY_BUDGET.queries || init?.method !== 'GET' ||
            parsed.origin !== 'https://api.hh.ru' || parsed.pathname !== '/resumes' ||
            parsed.searchParams.get('page') !== '0' || parsed.searchParams.get('per_page') !== '1')
          fail('provider_request_budget_violation');
        return fetchImpl(url, init);
      },
      userAgent: loadPrivateHostSecret(secretsDirectory, 'hh_user_agent'),
      pageLimit: 1, perPage: 1, maxAttempts: 1, allowPartialWindow: true });
    phase = 'provider_probe';
    const probes = [];
    for (const query of plan.queryCache.queries) {
      let result;
      try {
        result = await transport.search({ trustedContext: { profileId,
          scopes: ['recruiting.candidateSearch'] }, vacancyId, query, area: plan.area });
      } catch (error) {
        const reason = SAFE_PROVIDER_CODES.has(error?.code) ? error.code : 'provider_probe_failed';
        const httpStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
          ? error.status : null;
        fail(reason, httpStatus);
      }
      probes.push({ queryHash: hash(query), found: result.found ?? result.pages ?? 0,
        pagesAtOne: result.pages ?? 0 });
    }
    phase = 'state_consistency';
    const after = await loadPlan(profileId, vacancyId, { allowGeneration: false });
    if (after.criteriaRevision !== plan.criteriaRevision ||
        after.queryCache.revision !== plan.queryCache.revision ||
        JSON.stringify(after.queryCache.queries) !== JSON.stringify(plan.queryCache.queries))
      fail('source_state_changed');
    phase = 'receipt_write';
    const receipt = { ...createFullDiscoveryCostPreflight(plan, probes, clock().toISOString()),
      migrationId: stage.migrationId, sourceArchiveSha256: stage.sourceArchiveSha256,
      cronSha256: stage.cronSha256, requests, disposition: 'read_only_estimate' };
    writeFileSync(outputFile, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: receipt.status, reason: receipt.reason, queryCount: receipt.queryCount,
      requests, estimatedRequests: receipt.estimatedRequests,
      rawItemUpperBound: receipt.rawItemUpperBound,
      budget: receipt.budget, disposition: 'read_only_estimate' };
  } catch (error) {
    if (error?.safeDiagnostic) throw error;
    const reason = error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EEXIST'
      ? 'private_file_unavailable' : 'operation_failed';
    throw makeFailure({ phase, reason, providerRequestCount: requests });
  }
}

function args(argv) {
  const map = { '--host-config': 'hostConfigFile', '--stage-receipt': 'stageReceiptFile',
    '--secrets': 'secretsDirectory', '--output': 'outputFile', '--profile': 'profileId',
    '--vacancy': 'vacancyId' };
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute' && out.execute === undefined) out.execute = true;
    else {
      const field = map[argv[i]];
      if (!field || out[field] !== undefined) fail();
      out[field] = argv[++i];
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runPrivateFullCostPreflight(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_full_cost_preflight', ...result }) + '\n');
    if (result.status !== 'ready') process.exitCode = 2;
  } catch (error) {
    const detail = error?.safeDiagnostic || { phase: 'unknown', reason: 'operation_failed',
      httpStatus: null, providerRequestCount: 0 };
    process.stdout.write(JSON.stringify({ event: 'r03.private_full_cost_preflight', status: 'failed',
      code: 'private_full_cost_preflight_unavailable', diagnostic: detail }) + '\n');
    process.exitCode = 78;
  }
}
