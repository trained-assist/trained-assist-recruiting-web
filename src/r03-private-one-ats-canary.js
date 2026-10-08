import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  statSync, writeFileSync, constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';
import { createFreeLadderChat } from './r03-free-ladder-chat.js';
import { createHhAssessmentEvaluator } from './r03-hh-assessment-evaluator.js';
import { SqliteColdSearchScheduleRepository } from './sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState } from './sqlite-real-hh-candidate-state.js';
import { SqliteAcceptedAssessmentQueue } from './sqlite-accepted-assessment-queue.js';

// This is the deployed ladder build whose `free` rungs were reviewed to have
// a hard $0 ceiling. A new build needs a new operator review before any call.
const REVIEWED_LADDER_BUILD = '28766e4f7e86d5aa39a85ed77d1d7b8bb5e6077c';
const BASE = 'https://llm-ladder.trainedassist.store';
const safePath = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
const fail = () => { throw new Error('one_ats_canary_unavailable'); };
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const privateFile = path => {
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) fail();
};
const privateDir = path => {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) fail();
};
const freeRung = rung => typeof rung === 'string' && (
  rung.startsWith('zen-pool/') && rung.endsWith('-free') ||
  rung.startsWith('opencode-go/') && rung.endsWith('-free') ||
  rung.startsWith('openrouter/') && rung.endsWith(':free') ||
  rung.startsWith('opencode-zen/') && (rung.endsWith('-free') || rung === 'opencode-zen/big-pickle'));

function source({ hostConfigFile, sourceReceiptFile }) {
  const host = loadPrivateHostConfig(hostConfigFile);
  privateFile(sourceReceiptFile);
  const receipt = JSON.parse(readFileSync(sourceReceiptFile, 'utf8'));
  const sourceDbPath = join(dirname(sourceReceiptFile), 'candidate.sqlite');
  privateDir(dirname(sourceReceiptFile)); privateFile(sourceDbPath);
  if (receipt.version !== 'r03-private-full-discovery-rehearsal-v1' ||
      receipt.disposition !== 'disposable_full' || receipt.occurrenceStatus !== 'succeeded' ||
      receipt.disposableDiscoveryComplete !== true || receipt.published !== false ||
      receipt.candidateCount < 1 || receipt.assessmentRequests !== 0 ||
      !host.isVacancyOwned(receipt.profileId, receipt.vacancyId) ||
      sourceDbPath === host.dbPath) fail();
  const db = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
  try {
    const occurrence = db.prepare('SELECT payload FROM cold_search_occurrences WHERE occurrence_id=?')
      .get(receipt.occurrenceId);
    const row = occurrence && JSON.parse(occurrence.payload);
    const snapshot = db.prepare(`SELECT candidate_count,criteria_revision FROM real_hh_snapshot
      WHERE job_id=? AND profile_id=? AND vacancy_id=?`).get(receipt.jobId,
        receipt.profileId, receipt.vacancyId);
    if (row?.status !== 'succeeded' || row.jobId !== receipt.jobId ||
        snapshot?.candidate_count !== receipt.candidateCount) fail();
    return { host, receipt, sourceDbPath, sourceDbSha256: sha(sourceDbPath),
      sourceReceiptSha256: sha(sourceReceiptFile), criteriaRevision: snapshot.criteria_revision };
  } finally { db.close(); }
}

async function planFor(host, receipt, criteriaRevision) {
  const loadPlan = createPrivateBaseSearchPlan({ resolveProfileBinding: host.resolveProfileBinding,
    isVacancyOwned: host.isVacancyOwned });
  const plan = await loadPlan(receipt.profileId, receipt.vacancyId, { allowGeneration: false });
  if (plan.queryCache.pendingGeneration || plan.criteriaRevision !== criteriaRevision) fail();
  return { loadPlan, plan };
}

async function ladderPolicy(secretsDirectory, fetchImpl) {
  privateDir(secretsDirectory);
  const token = loadPrivateHostSecret(secretsDirectory, 'ladder_token');
  const health = await fetchImpl(`${BASE}/health`, { signal: AbortSignal.timeout(10_000) });
  const healthData = health.ok ? await health.json() : null;
  const models = await fetchImpl(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000) });
  const modelsData = models.ok ? await models.json() : null;
  const free = modelsData?.data?.find(row => row.id === 'free');
  if (healthData?.build !== REVIEWED_LADDER_BUILD || !models.ok ||
      !Array.isArray(free?.rungs) || free.rungs.length < 1 || !free.rungs.every(freeRung)) fail();
  return { build: healthData.build, rungCount: free.rungs.length };
}

function boundedModelFetch(fetchImpl, onDispatch, onOutcome = () => {}) {
  let dispatched = false;
  return async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}');
    if (dispatched || url !== `${BASE}/v1/chat/completions` || init?.method !== 'POST' ||
        body.model !== 'free' || body.max_tokens !== 600 || body.messages?.length !== 1)
      fail();
    dispatched = true;
    onDispatch();
    try {
      const response = await fetchImpl(url, init);
      const status = Number(response?.status);
      onOutcome(Number.isInteger(status) && status >= 100 && status <= 599
        ? { kind: response.ok === true ? 'http_success' : 'http_error', status }
        : { kind: 'invalid_http_response' });
      return response;
    } catch {
      // Preserve only a safe failure category. Never persist provider body,
      // prompt, candidate data, credentials, or raw exception text.
      onOutcome({ kind: 'transport_error' });
      throw new Error('ladder_transport_unavailable');
    }
  };
}

function assessmentOutcome(result, observation) {
  if (result.written === 1) return { outcomeClass: 'assessed', providerHttpStatus: observation.status ?? null };
  if (observation.kind === 'http_error')
    return { outcomeClass: 'provider_http_error', providerHttpStatus: observation.status };
  if (observation.kind === 'transport_error')
    return { outcomeClass: 'provider_transport_error', providerHttpStatus: null };
  if (observation.kind === 'invalid_http_response')
    return { outcomeClass: 'provider_response_invalid', providerHttpStatus: null };
  if (observation.kind === 'http_success')
    return { outcomeClass: 'provider_response_unusable', providerHttpStatus: observation.status };
  return { outcomeClass: 'provider_outcome_unobserved', providerHttpStatus: null };
}

export async function runPrivateOneAtsCanary({ mode, hostConfigFile, sourceReceiptFile,
  secretsDirectory, preflightFile, outputDirectory, fetchImpl = globalThis.fetch,
  clock = () => new Date() } = {}) {
  if (!['preflight', 'run', 'replay'].includes(mode) ||
      ![hostConfigFile, sourceReceiptFile, secretsDirectory, preflightFile,
        outputDirectory].every(safePath) || typeof fetchImpl !== 'function' ||
      typeof clock !== 'function') fail();
  privateDir(dirname(preflightFile)); privateDir(dirname(outputDirectory));
  const input = source({ hostConfigFile, sourceReceiptFile });
  const { loadPlan, plan } = await planFor(input.host, input.receipt, input.criteriaRevision);
  if (mode === 'preflight') {
    if (existsSync(preflightFile) || existsSync(outputDirectory)) fail();
    const policy = await ladderPolicy(secretsDirectory, fetchImpl);
    let dispatched = 0;
    const chat = createFreeLadderChat({ loadToken: () =>
      loadPrivateHostSecret(secretsDirectory, 'ladder_token'),
    fetchImpl: boundedModelFetch(fetchImpl, () => { dispatched++; }) });
    const evaluate = createHhAssessmentEvaluator({ loadSearchPlan: async () => plan, chat });
    const result = await evaluate({ profileId: input.receipt.profileId,
      vacancyId: input.receipt.vacancyId,
      candidate: { id: 'invented_ats_preflight', vacancyId: input.receipt.vacancyId,
        title: 'Вымышленный специалист', totalExperienceYears: 0,
        recentCompanies: [], experience: [] },
      criteriaRevision: plan.criteriaRevision, inputRevision: 'a'.repeat(32) });
    if (dispatched !== 1 || !['PASS', 'REVIEW', 'WEAK'].includes(result.atsTag)) fail();
    const receipt = { version: 'r03-one-ats-preflight-v1', at: clock().toISOString(),
      build: policy.build, rungCount: policy.rungCount,
      sourceDbSha256: input.sourceDbSha256,
      sourceReceiptSha256: input.sourceReceiptSha256,
      profileId: input.receipt.profileId, vacancyId: input.receipt.vacancyId,
      jobId: input.receipt.jobId, criteriaRevision: plan.criteriaRevision,
      inventedDispatches: 1, inventedAccepted: true, maxOutputTokens: 600,
      allowedRealDispatches: 1 };
    writeFileSync(preflightFile, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: 'ready', inventedDispatches: 1, rungCount: policy.rungCount,
      freeBuildMatched: true, allowedRealDispatches: 1 };
  }
  privateFile(preflightFile);
  const preflight = JSON.parse(readFileSync(preflightFile, 'utf8'));
  if (preflight.version !== 'r03-one-ats-preflight-v1' ||
      preflight.build !== REVIEWED_LADDER_BUILD || preflight.inventedDispatches !== 1 ||
      preflight.inventedAccepted !== true || preflight.allowedRealDispatches !== 1 ||
      preflight.sourceDbSha256 !== input.sourceDbSha256 ||
      preflight.sourceReceiptSha256 !== input.sourceReceiptSha256 ||
      preflight.profileId !== input.receipt.profileId ||
      preflight.vacancyId !== input.receipt.vacancyId ||
      preflight.jobId !== input.receipt.jobId ||
      preflight.criteriaRevision !== plan.criteriaRevision ||
      !Number.isFinite(Date.parse(preflight.at))) fail();
  const receiptFile = join(outputDirectory, 'receipt.json');
  if (mode === 'replay') {
    privateDir(outputDirectory); privateFile(receiptFile);
    const prior = JSON.parse(readFileSync(receiptFile, 'utf8'));
    if (prior.version !== 'r03-one-ats-canary-v1' ||
        prior.sourceDbSha256 !== input.sourceDbSha256 ||
        prior.sourceReceiptSha256 !== input.sourceReceiptSha256 ||
        prior.jobId !== input.receipt.jobId || prior.providerRequests !== 1) fail();
    const copy = new Database(join(outputDirectory, 'candidate.sqlite'),
      { readonly: true, fileMustExist: true });
    try {
      const row = copy.prepare(`SELECT status,input_revision FROM r03_accepted_assessment_queue
        WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`).get(
        prior.profileId, prior.vacancyId, prior.jobId, prior.resumeId);
      const assessed = copy.prepare(`SELECT input_revision FROM real_hh_assessment
        WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`).get(
        prior.profileId, prior.vacancyId, prior.jobId, prior.resumeId);
      if (row?.input_revision !== prior.inputRevision ||
          (prior.written === 1 && (row.status !== 'completed' ||
            assessed?.input_revision !== prior.inputRevision)) ||
          (prior.unknown === 1 && (row.status !== 'outcome_unknown' || assessed))) fail();
    } finally { copy.close(); }
    return { status: 'replayed', providerRequests: 0,
      written: prior.written, unknown: prior.unknown,
      outcomeClass: prior.outcomeClass ?? 'legacy_unclassified',
      providerHttpStatus: Number.isInteger(prior.providerHttpStatus) ? prior.providerHttpStatus : null,
      disposableOnly: true };
  }
  if (existsSync(outputDirectory)) fail(); // An incomplete run is uncertain; never auto retry.
  if (clock().getTime() < Date.parse(preflight.at) ||
      clock().getTime() - Date.parse(preflight.at) > 15 * 60_000) fail();
  const currentPolicy = await ladderPolicy(secretsDirectory, fetchImpl);
  if (currentPolicy.build !== preflight.build || currentPolicy.rungCount !== preflight.rungCount) fail();
  mkdirSync(outputDirectory, { mode: 0o700 });
  const dbPath = join(outputDirectory, 'candidate.sqlite');
  // This source is an inert, owner-only disposable snapshot. A byte copy is
  // allowed only with an empty/absent WAL and matching before/after hashes.
  // Do not copy a live writer or retry an incomplete output directory.
  const walPath = `${input.sourceDbPath}-wal`;
  if (existsSync(walPath) && statSync(walPath).size !== 0) fail();
  copyFileSync(input.sourceDbPath, dbPath, constants.COPYFILE_EXCL);
  chmodSync(dbPath, 0o600);
  if (sha(dbPath) !== input.sourceDbSha256 || sha(input.sourceDbPath) !== input.sourceDbSha256 ||
      existsSync(walPath) && statSync(walPath).size !== 0) fail();
  const schedules = new SqliteColdSearchScheduleRepository(dbPath);
  const candidates = new SqliteRealHhCandidateState({ filename: dbPath,
    isVacancyOwned: input.host.isVacancyOwned });
  let queue, providerRequests = 0, providerObservation = { kind: 'not_observed' };
  try {
    const evaluate = createHhAssessmentEvaluator({ loadSearchPlan: (p, v) =>
      loadPlan(p, v, { allowGeneration: false }),
    chat: createFreeLadderChat({ loadToken: () =>
      loadPrivateHostSecret(secretsDirectory, 'ladder_token'),
    fetchImpl: boundedModelFetch(fetchImpl, () => { providerRequests++; },
      value => { providerObservation = value; }) }) });
    queue = new SqliteAcceptedAssessmentQueue({ filename: dbPath,
      candidateState: candidates, scheduleRepository: schedules,
      evaluate, currentCriteriaRevision: async ({ profileId, vacancyId }) =>
        (await loadPlan(profileId, vacancyId, { allowGeneration: false })).criteriaRevision,
      clock });
    const accepted = queue.accepted(input.receipt.profileId, input.receipt.vacancyId);
    if (!accepted.includes(input.receipt.jobId) || accepted.length !== 1 ||
        schedules.listAllSchedules().some(row => row.enabled) ||
        schedules.db.pragma('integrity_check', { simple: true }) !== 'ok') fail();
    const result = await queue.tick(input.receipt.profileId, input.receipt.vacancyId,
      'one_ats_canary', 1, { deadlineMs: clock().getTime() + 120_000 });
    if (result.claimed !== 1 || providerRequests !== 1 ||
        result.written + result.unknown + result.blocked !== 1 ||
        schedules.db.pragma('integrity_check', { simple: true }) !== 'ok' ||
        sha(input.sourceDbPath) !== input.sourceDbSha256) fail();
    const affected = queue.db.prepare(`SELECT resume_id,input_revision,status
      FROM r03_accepted_assessment_queue WHERE profile_id=? AND vacancy_id=?
        AND job_id=? AND status IN ('completed','outcome_unknown','blocked_criteria_stale','blocked_unaccepted')`)
      .all(input.receipt.profileId, input.receipt.vacancyId, input.receipt.jobId);
    if (affected.length !== 1 || (result.written && affected[0].status !== 'completed') ||
        (result.unknown && affected[0].status !== 'outcome_unknown')) fail();
    const diagnostic = assessmentOutcome(result, providerObservation);
    const receipt = { version: 'r03-one-ats-canary-v1', disposition: 'disposable_only',
      sourceDbSha256: input.sourceDbSha256,
      sourceReceiptSha256: input.sourceReceiptSha256,
      profileId: input.receipt.profileId, vacancyId: input.receipt.vacancyId,
      jobId: input.receipt.jobId, resumeId: affected[0].resume_id,
      inputRevision: affected[0].input_revision,
      providerRequests, claimed: result.claimed,
      written: result.written, unknown: result.unknown, blocked: result.blocked,
      assessmentStatus: result.written ? 'assessed' : result.blocked ?
        'blocked_revision_or_acceptance' : 'outcome_unknown',
      ...diagnostic,
      published: false };
    writeFileSync(receiptFile, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: receipt.assessmentStatus, providerRequests,
      claimed: result.claimed, written: result.written, unknown: result.unknown,
      blocked: result.blocked, outcomeClass: diagnostic.outcomeClass,
      providerHttpStatus: diagnostic.providerHttpStatus,
      published: false, disposableOnly: true };
  } finally { queue?.close(); candidates.close(); schedules.close(); }
}

function args(argv) {
  const names = ['mode', 'hostConfigFile', 'sourceReceiptFile', 'secretsDirectory',
    'preflightFile', 'outputDirectory'];
  if (argv.length !== names.length) fail();
  return Object.fromEntries(names.map((name, index) => [name, argv[index]]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runPrivateOneAtsCanary(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.one_ats_canary', ...result }) + '\n');
    if (result.status === 'outcome_unknown') process.exitCode = 2;
  } catch {
    process.stdout.write('{"event":"r03.one_ats_canary","status":"failed"}\n');
    process.exitCode = 78;
  }
}
