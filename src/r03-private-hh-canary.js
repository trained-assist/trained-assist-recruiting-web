import { fileURLToPath } from 'node:url';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';
import { createPrivateHhCredentialBroker } from './r03-private-hh-credential.js';
import { resolveHhSearchAreas, validateHhUserAgent } from './hh-resume-transport.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = () => { throw new Error('private_hh_canary_unavailable'); };

// Exactly one read-only HH request. No query generation, token refresh,
// candidate persistence, schedule claim, or response body reaches stdout.
export async function runPrivateHhCanary({ configFile, secretsDirectory, profileId,
  vacancyId, execute = false, fetchImpl = globalThis.fetch } = {}) {
  if (!execute || !safeId(profileId) || !safeId(vacancyId) ||
      typeof fetchImpl !== 'function') fail();
  const config = loadPrivateHostConfig(configFile);
  if (!config.isVacancyOwned(profileId, vacancyId)) fail();
  const userAgent = validateHhUserAgent(loadPrivateHostSecret(secretsDirectory, 'hh_user_agent'));
  const encryptionKey = loadPrivateHostSecret(secretsDirectory, 'hh_encryption_key');
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) fail();
  const loadBasePlan = createPrivateBaseSearchPlan({ resolveProfileBinding: config.resolveProfileBinding,
    isVacancyOwned: config.isVacancyOwned });
  const plan = await loadBasePlan(profileId, vacancyId, { allowGeneration: false });
  if (plan.queryCache.pendingGeneration || plan.queryCache.queries.length === 0) fail();
  const areas = resolveHhSearchAreas({ area: plan.area });
  const broker = createPrivateHhCredentialBroker({ resolveProfileBinding: config.resolveProfileBinding,
    encryptionKey, fetchImpl });
  const credential = await broker.loadCredential(profileId);
  if (credential.profileId !== profileId || !credential.accessToken) fail();
  const params = new URLSearchParams({ text: plan.queryCache.queries[0], page: '0',
    per_page: '1', order_by: 'relevance' });
  for (const area of areas) params.append('area', area);
  let response;
  try {
    response = await fetchImpl(`https://api.hh.ru/resumes?${params}`, { method: 'GET',
      headers: { Authorization: `Bearer ${credential.accessToken}`, 'User-Agent': userAgent,
        'HH-User-Agent': userAgent }, signal: AbortSignal.timeout(20_000) });
  } catch { fail(); }
  if (!response || !Number.isInteger(response.status) || typeof response.json !== 'function') fail();
  if (response.status !== 200) return { status: 'provider_rejected', httpStatus: response.status };
  let body;
  try { body = await response.json(); } catch { fail(); }
  if (!body || !Array.isArray(body.items) || body.items.length > 1 ||
      !Number.isSafeInteger(body.found) || body.found < 0 ||
      !Number.isSafeInteger(body.pages) || body.pages < 0) fail();
  return { status: 'ok', httpStatus: 200, returnedCount: body.items.length,
    foundCount: body.found, pageCount: body.pages };
}

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute' && options.execute === undefined) options.execute = true;
    else if (arg === '--config' && options.configFile === undefined) options.configFile = argv[++i];
    else if (arg === '--secrets' && options.secretsDirectory === undefined) options.secretsDirectory = argv[++i];
    else if (arg === '--profile' && options.profileId === undefined) options.profileId = argv[++i];
    else if (arg === '--vacancy' && options.vacancyId === undefined) options.vacancyId = argv[++i];
    else fail();
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runPrivateHhCanary(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_hh_canary', ...result }) + '\n');
    if (result.status !== 'ok') process.exitCode = 2;
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_hh_canary', status: 'failed',
      code: 'private_hh_canary_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
