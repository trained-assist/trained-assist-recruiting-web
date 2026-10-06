import { fileURLToPath } from 'node:url';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';
import { createServiceLadderChat } from './r03-service-ladder-chat.js';
import { createFreeLadderChat } from './r03-free-ladder-chat.js';
import { createHhQueryGenerator } from './r03-hh-query-generator.js';
import { createHhAssessmentEvaluator } from './r03-hh-assessment-evaluator.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = () => { throw new Error('private_ladder_canary_unavailable'); };

// A bounded provider preflight: one service query-generation call followed by
// one free assessment call for an invented candidate. It never opens SQLite or
// sends a real candidate, persists a result, or starts a scheduled job.
export async function runPrivateLadderCanary({ configFile, secretsDirectory, profileId,
  vacancyId, execute = false, fetchImpl = globalThis.fetch } = {}) {
  if (!execute || !safeId(profileId) || !safeId(vacancyId) || typeof fetchImpl !== 'function') fail();
  const config = loadPrivateHostConfig(configFile);
  if (!config.isVacancyOwned(profileId, vacancyId)) fail();
  const plan = await createPrivateBaseSearchPlan({ resolveProfileBinding: config.resolveProfileBinding,
    isVacancyOwned: config.isVacancyOwned })(profileId, vacancyId, { allowGeneration: false });
  if (plan.queryCache.pendingGeneration || !plan.queryCache.queries.length) fail();
  const loadToken = () => loadPrivateHostSecret(secretsDirectory, 'ladder_token');
  // Resolve the exact token before either provider call; the same owner-only
  // credential is supplied to both established ladder adapters.
  loadToken();
  const generate = createHhQueryGenerator({ chat: createServiceLadderChat({ loadToken, fetchImpl }) });
  const generated = await generate({ profileId, vacancyId, atsConfig: plan.atsConfig, comments: [] });
  const evaluate = createHhAssessmentEvaluator({ loadSearchPlan: async () => plan,
    chat: createFreeLadderChat({ loadToken, fetchImpl }) });
  const assessment = await evaluate({ profileId, vacancyId,
    candidate: { id: 'invented_canary_resume', vacancyId, title: 'Вымышленный специалист',
      totalExperienceYears: 0, recentCompanies: [], experience: [] },
    criteriaRevision: plan.criteriaRevision, inputRevision: 'a'.repeat(32) });
  if (!Number.isInteger(generated.length) || generated.length < 1 || generated.length > 15 ||
      !['PASS', 'REVIEW', 'WEAK'].includes(assessment.atsTag)) fail();
  return { status: 'ok', serviceQueryCount: generated.length,
    freeAssessmentAccepted: true };
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
    const result = await runPrivateLadderCanary(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_ladder_canary', ...result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_ladder_canary', status: 'failed',
      code: 'private_ladder_canary_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
