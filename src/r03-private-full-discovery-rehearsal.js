import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { digestPrivateFile, privateDirectory, readPrivateJson } from './r03-private-legacy-archive.js';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';
import { createPrivateHhCredentialBroker } from './r03-private-hh-credential.js';
import { createBudgetedFullHhDiscovery, FULL_DISCOVERY_BUDGET } from './r03-full-discovery-budget.js';
import { SqliteColdSearchScheduleRepository } from './sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState } from './sqlite-real-hh-candidate-state.js';
import { SqliteAcceptedAssessmentQueue } from './sqlite-accepted-assessment-queue.js';
import { intervalPlan, nextOccurrenceAfter } from './cold-search-schedules.js';
import { runPrivateHhMinuteTick } from './r03-private-minute-tick.js';
import { createR03AccumulatedRealFeed } from './r03-accumulated-real-feed.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const absolute = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('private_full_discovery_rehearsal_unavailable'); };

// One full search on a new disposable copy. The full current query set and
// every provider page must fit the budget before one snapshot can be accepted
// in that copy. No ATS/LLM call, timer or public route is made here.
export async function runPrivateFullDiscoveryRehearsal({ hostConfigFile, stageReceiptFile,
  preflightReceiptFile, secretsDirectory, outputDirectory, profileId, vacancyId,
  naturalScheduleId = null, expectedNaturalAt = null,
  execute = false, fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  if (!execute || ![hostConfigFile, stageReceiptFile, preflightReceiptFile, secretsDirectory,
    outputDirectory].every(absolute) || !safeId(profileId) || !safeId(vacancyId) ||
      typeof fetchImpl !== 'function' || typeof clock !== 'function') fail();
  privateDirectory(dirname(outputDirectory));
  const host = loadPrivateHostConfig(hostConfigFile);
  if (!host.isVacancyOwned(profileId, vacancyId)) fail();
  const stage = readPrivateJson(stageReceiptFile, 1024 * 1024);
  const preflight = readPrivateJson(preflightReceiptFile, 1024 * 1024);
  if (stage?.version !== 'r03-private-schedule-stage-v1' || stage.status !== 'disposable_only' ||
      stage.sourceDbPath !== host.dbPath || stage.stagedDbPath !== join(dirname(stageReceiptFile), 'candidate.sqlite') ||
      stage.imported !== 11 || stage.unknownQuarantined !== 8 || stage.enabled !== 0 ||
      preflight?.version !== 'r03-full-discovery-cost-preflight-v1' || preflight.status !== 'ready' ||
      preflight.disposition !== 'read_only_estimate' || preflight.migrationId !== stage.migrationId ||
      preflight.sourceArchiveSha256 !== stage.sourceArchiveSha256 || preflight.cronSha256 !== stage.cronSha256 ||
      preflight.profileId !== profileId || preflight.vacancyId !== vacancyId ||
      preflight.requests !== preflight.queryCount ||
      JSON.stringify(preflight.budget) !== JSON.stringify(FULL_DISCOVERY_BUDGET) ||
      outputDirectory === dirname(stageReceiptFile) || outputDirectory === dirname(host.dbPath)) fail();
  const natural = naturalScheduleId !== null || expectedNaturalAt !== null;
  if (natural && (!safeId(naturalScheduleId) || !Number.isFinite(Date.parse(expectedNaturalAt)))) fail();
  const receiptFile = join(outputDirectory, 'receipt.json');
  if (existsSync(outputDirectory)) {
    privateDirectory(outputDirectory);
    if (!existsSync(receiptFile)) fail();
    const prior = readPrivateJson(receiptFile, 1024 * 1024);
    if (prior?.version !== 'r03-private-full-discovery-rehearsal-v1' ||
        prior.migrationId !== stage.migrationId || prior.profileId !== profileId ||
        prior.vacancyId !== vacancyId || prior.disposition !== (natural ? 'disposable_natural' : 'disposable_full') ||
        (natural && (prior.scheduleId !== naturalScheduleId || prior.scheduledAt !== expectedNaturalAt))) fail();
    let occurrence;
    const db = new Database(join(outputDirectory, 'candidate.sqlite'), { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT payload FROM cold_search_occurrences WHERE occurrence_id=?').get(prior.occurrenceId);
      occurrence = row && JSON.parse(row.payload);
      if (occurrence?.status !== prior.occurrenceStatus || occurrence?.jobId !== prior.jobId) fail();
    } finally { db.close(); }
    if (prior.occurrenceStatus === 'succeeded') {
      const replaySchedules = new SqliteColdSearchScheduleRepository(join(outputDirectory, 'candidate.sqlite'));
      const replayCandidates = new SqliteRealHhCandidateState({ filename: join(outputDirectory, 'candidate.sqlite'),
        isVacancyOwned: host.isVacancyOwned });
      try {
        const feed = createR03AccumulatedRealFeed({ scheduleRepository: replaySchedules,
          candidateState: replayCandidates }).read({ profileId, scopes: ['recruiting.candidateSearch'] }, vacancyId);
        const scheduledItems = feed.items.filter(item => item.jobId === prior.jobId);
        const persisted = replayCandidates.resultPage({ profileId, vacancyId, jobId: prior.jobId, limit: 1 })?.snapshot;
        if (prior.morningFreshness !== 'latest_completed' || !safeId(prior.morningFeedRevision) ||
            feed.resultRevision !== prior.morningFeedRevision || feed.total !== prior.morningFeedCount ||
            scheduledItems.length !== persisted?.candidateCount || persisted?.candidateCount !== prior.candidateCount ||
            persisted?.resultRevision !== occurrence?.snapshot?.resultRevision ||
            persisted?.sourceRevision !== occurrence?.snapshot?.sourceRevision ||
            persisted?.candidateCount !== occurrence?.snapshot?.resultCount || feed.freshness !== 'latest_completed') fail();
      } finally { replayCandidates.close(); replaySchedules.close(); }
    }
    return { status: 'replayed', originalStatus: prior.occurrenceStatus,
      providerRequests: 0, assessmentRequests: 0,
      disposableDiscoveryComplete: prior.disposableDiscoveryComplete, published: false };
  }
  for (const path of [host.dbPath, stage.stagedDbPath]) {
    const info = lstatSync(path);
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) fail();
  }
  const sourceBefore = await digestPrivateFile(host.dbPath, 1024 * 1024 * 1024);
  const stageBefore = await digestPrivateFile(stage.stagedDbPath, 1024 * 1024 * 1024);
  const staged = new Database(stage.stagedDbPath, { readonly: true, fileMustExist: true });
  try {
    const counts = staged.prepare('SELECT COUNT(*) AS n,SUM(enabled) AS enabled FROM cold_search_schedules').get();
    const unknown = staged.prepare('SELECT payload FROM cold_search_schedules').all()
      .filter(row => JSON.parse(row.payload).migrationQuarantine?.reason === 'legacy_outcome_unknown').length;
    if (counts.n !== 11 || counts.enabled !== 0 || unknown !== 8 ||
        staged.prepare('SELECT COUNT(*) AS n FROM cold_search_occurrences').get().n !== 0) fail();
    if (natural) {
      const row = staged.prepare('SELECT payload FROM cold_search_schedules WHERE schedule_id=?').get(naturalScheduleId);
      const schedule = row && JSON.parse(row.payload);
      if (schedule?.profileId !== profileId || schedule?.vacancyId !== vacancyId ||
          schedule.plan?.intervalHours !== 24 || schedule.nextRunAt !== expectedNaturalAt ||
          schedule.migrationQuarantine?.reason !== 'cutover_review_required' ||
          schedule.migrationQuarantine?.migrationId !== stage.migrationId ||
          !schedule.blockedByUnknownOccurrenceId || schedule.enabled ||
          schedule.timezone !== 'Europe/Moscow') fail();
    }
    mkdirSync(outputDirectory, { mode: 0o700 });
    await staged.backup(join(outputDirectory, 'candidate.sqlite'));
  } finally { staged.close(); }
  const filename = join(outputDirectory, 'candidate.sqlite');
  chmodSync(filename, 0o600);
  const schedules = new SqliteColdSearchScheduleRepository(filename);
  const candidates = new SqliteRealHhCandidateState({ filename, isVacancyOwned: host.isVacancyOwned });
  let queue;
  try {
    const loadPlan = createPrivateBaseSearchPlan({ resolveProfileBinding: host.resolveProfileBinding,
      isVacancyOwned: host.isVacancyOwned });
    const plan = await loadPlan(profileId, vacancyId, { allowGeneration: false });
    if (plan.queryCache.pendingGeneration || plan.criteriaRevision !== preflight.criteriaRevision ||
        plan.queryCache.revision !== preflight.queryRevision ||
        JSON.stringify(plan.queryCache.queries.map(hash)) !== JSON.stringify(preflight.queryHashes)) fail();
    const encryptionKey = loadPrivateHostSecret(secretsDirectory, 'hh_encryption_key');
    if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) fail();
    const credentials = createPrivateHhCredentialBroker({ resolveProfileBinding: host.resolveProfileBinding,
      encryptionKey, fetchImpl });
    await credentials.loadCredential(profileId);
    const now = clock().toISOString();
    if (!Number.isFinite(Date.parse(preflight.at)) || Date.parse(now) < Date.parse(preflight.at) ||
        Date.parse(now) - Date.parse(preflight.at) > 15 * 60_000) fail();
    queue = new SqliteAcceptedAssessmentQueue({ filename, candidateState: candidates,
      scheduleRepository: schedules,
      evaluate: async () => { throw new Error('assessment_not_enabled_in_rehearsal'); },
      currentCriteriaRevision: async () => plan.criteriaRevision, clock });
    let providerRequests = 0;
    const full = createBudgetedFullHhDiscovery({ scheduleRepository: schedules,
      candidateState: candidates, assessmentQueue: queue,
      loadSearchPlan: (p, v) => loadPlan(p, v, { allowGeneration: false }),
      loadCredential: credentials.loadCredential,
      loadVacancyContext: async (p, v) => ({ profileId: p, vacancyId: v, config: plan.atsConfig }),
      fetchImpl: async (url, init) => {
        const parsed = new URL(url);
        if (providerRequests >= FULL_DISCOVERY_BUDGET.requests || init?.method !== 'GET' ||
            parsed.origin !== 'https://api.hh.ru' || parsed.pathname !== '/resumes' ||
            parsed.searchParams.get('per_page') !== '50' ||
            !/^\d+$/.test(parsed.searchParams.get('page') ?? '') ||
            Number(parsed.searchParams.get('page')) >= FULL_DISCOVERY_BUDGET.pagesPerQuery) fail();
        providerRequests++;
        return fetchImpl(url, init);
      }, userAgent: loadPrivateHostSecret(secretsDirectory, 'hh_user_agent'),
      preflightFor: async () => preflight, clock });
    const key = hash([stage.migrationId, profileId, vacancyId, now]).slice(0, 24);
    const scheduleId = natural ? naturalScheduleId : `full_rehearsal_schedule_${key}`;
    if (natural) {
      const due = Date.parse(expectedNaturalAt);
      if (Date.parse(now) < due || Date.parse(now) - due > 5 * 60_000) fail();
      const selected = schedules.getSchedule(scheduleId);
      schedules.persistSchedule({ ...selected, enabled: true,
        blockedByUnknownOccurrenceId: null, migrationQuarantine: null });
    } else {
      const schedulePlan = intervalPlan(24, vacancyId);
      schedules.upsertSchedule({ scheduleId, legacyJobId: `full_rehearsal_job_${key}`,
        profileId, vacancyId, enabled: true, plan: schedulePlan, timezone: 'Europe/Moscow',
        jobArguments: { vacancyId }, nextRunAt: nextOccurrenceAfter(schedulePlan,
          new Date(Date.parse(now) - 48 * 60 * 60_000).toISOString()),
        leaseOwner: null, leaseUntil: null, blockedByUnknownOccurrenceId: null });
    }
    const tick = await runPrivateHhMinuteTick({ worker: full.worker, scheduleRepository: schedules,
      workerId: `full_rehearsal_worker_${key}`, clock });
    const occurrence = schedules.listOccurrences(profileId).filter(row => row.scheduleId === scheduleId);
    if (occurrence.length !== 1 || tick.result?.claimed !== 1) fail();
    if (natural && (occurrence[0].scheduledAt !== expectedNaturalAt ||
        occurrence[0].coalescedMissedCount !== 0)) fail();
    const synthetic = schedules.getSchedule(scheduleId);
    schedules.persistSchedule({ ...synthetic, enabled: false,
      blockedByUnknownOccurrenceId: `disposable_full_${key}`,
      migrationQuarantine: { reason: natural ? 'disposable_natural' : 'disposable_full', migrationId: stage.migrationId } });
    let assessmentStatus = 'not_applicable';
    let assessmentPendingCount = 0;
    let candidateCount = 0;
    let newCount = 0;
    if (occurrence[0].status === 'succeeded') {
      queue.sync(profileId, vacancyId); // durable pending rows; never calls the evaluator
      const morning = full.morningResults(profileId, vacancyId, { limit: 1 });
      if (morning.status !== 'completed' || morning.snapshot.jobId !== occurrence[0].jobId) fail();
      const trustedTestContext = { profileId, scopes: ['recruiting.candidateSearch'] };
      const feed = createR03AccumulatedRealFeed({ scheduleRepository: schedules, candidateState: candidates,
        assessmentQueue: queue }).read(trustedTestContext, vacancyId);
      const selectedFromFeed = feed.items.filter(item => item.jobId === occurrence[0].jobId);
      const persisted = candidates.resultPage({ profileId, vacancyId, jobId: occurrence[0].jobId, limit: 1 })?.snapshot;
      if (feed.status !== 'completed' || feed.freshness !== 'latest_completed' ||
          !feed.resultRevision || selectedFromFeed.length !== persisted?.candidateCount ||
          persisted?.resultRevision !== occurrence[0].snapshot?.resultRevision ||
          persisted?.sourceRevision !== occurrence[0].snapshot?.sourceRevision ||
          persisted?.candidateCount !== occurrence[0].snapshot?.resultCount ||
          feed.total !== occurrence[0].snapshot?.resultCount) fail();
      assessmentStatus = morning.assessmentStatus;
      assessmentPendingCount = morning.assessmentPendingCount;
      candidateCount = morning.snapshot.candidateCount;
      newCount = morning.snapshot.newCount;
    }
    if (schedules.listAllSchedules().filter(row => row.scheduleId !== scheduleId).some(row =>
        row.enabled || !row.blockedByUnknownOccurrenceId) ||
        schedules.db.pragma('integrity_check', { simple: true }) !== 'ok') fail();
    const [sourceAfter, stageAfter] = await Promise.all([
      digestPrivateFile(host.dbPath, 1024 * 1024 * 1024),
      digestPrivateFile(stage.stagedDbPath, 1024 * 1024 * 1024)
    ]);
    if (sourceAfter.sha256 !== sourceBefore.sha256 || stageAfter.sha256 !== stageBefore.sha256) fail();
    const receipt = { version: 'r03-private-full-discovery-rehearsal-v1',
      disposition: natural ? 'disposable_natural' : 'disposable_full', migrationId: stage.migrationId,
      sourceArchiveSha256: stage.sourceArchiveSha256, cronSha256: stage.cronSha256,
      preflightSha256: (await digestPrivateFile(preflightReceiptFile, 1024 * 1024)).sha256,
      profileId, vacancyId, scheduleId, scheduledAt: occurrence[0].scheduledAt,
      occurrenceId: occurrence[0].occurrenceId,
      occurrenceStatus: occurrence[0].status, errorCode: occurrence[0].errorCode,
      jobId: occurrence[0].jobId, providerRequests, assessmentRequests: 0,
      queryCount: plan.queryCache.queries.length, candidateCount, newCount,
      assessmentStatus, assessmentPendingCount,
      morningFreshness: occurrence[0].status === 'succeeded' ? 'latest_completed' : 'latest_run_incomplete',
      morningFeedRevision: occurrence[0].status === 'succeeded'
        ? createR03AccumulatedRealFeed({ scheduleRepository: schedules, candidateState: candidates,
          assessmentQueue: queue }).read({ profileId, scopes: ['recruiting.candidateSearch'] }, vacancyId).resultRevision : null,
      morningFeedCount: occurrence[0].status === 'succeeded' ? candidateCount : 0,
      disposableDiscoveryComplete: occurrence[0].status === 'succeeded', published: false,
      budget: FULL_DISCOVERY_BUDGET };
    writeFileSync(receiptFile, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: receipt.occurrenceStatus, errorCode: receipt.errorCode,
      providerRequests, assessmentRequests: 0, queryCount: receipt.queryCount,
      candidateCount, newCount, assessmentStatus, assessmentPendingCount,
      disposableDiscoveryComplete: receipt.disposableDiscoveryComplete, published: false };
  } finally { queue?.close(); candidates.close(); schedules.close(); }
}

function args(argv) {
  const map = { '--host-config': 'hostConfigFile', '--stage-receipt': 'stageReceiptFile',
    '--preflight-receipt': 'preflightReceiptFile', '--secrets': 'secretsDirectory',
    '--output-directory': 'outputDirectory', '--profile': 'profileId', '--vacancy': 'vacancyId' };
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
    const result = await runPrivateFullDiscoveryRehearsal(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_full_discovery_rehearsal', ...result }) + '\n');
    if (result.status !== 'succeeded' &&
        !(result.status === 'replayed' && result.originalStatus === 'succeeded')) process.exitCode = 2;
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_full_discovery_rehearsal', status: 'failed',
      code: 'private_full_discovery_rehearsal_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
