import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { digestPrivateFile, privateDirectory, readPrivateJson } from './r03-private-legacy-archive.js';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';
import { createPrivateHhCredentialBroker } from './r03-private-hh-credential.js';
import { createHhResumeTransport } from './hh-resume-transport.js';
import { createOfflineHhColdSearch } from './hh-cold-search-offline.js';
import { createDurableHhOccurrenceWorker } from './r03-durable-hh-worker.js';
import { runPrivateHhMinuteTick } from './r03-private-minute-tick.js';
import { runAcceptedMorningScoringTick } from './r03-morning-scoring.js';
import { createHhAssessmentEvaluator } from './r03-hh-assessment-evaluator.js';
import { createFreeLadderChat } from './r03-free-ladder-chat.js';
import { intervalPlan, nextOccurrenceAfter } from './cold-search-schedules.js';
import { SqliteColdSearchScheduleRepository } from './sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState } from './sqlite-real-hh-candidate-state.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const absolute = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('private_scheduled_rehearsal_unavailable'); };
const limits = Object.freeze({ queries: 1, pages: 1, perPage: 1, hhAttempts: 1, assessments: 1 });

// A new disposable copy receives one invented, immediately due schedule. The
// eleven imported schedules remain disabled and quarantined throughout.
export async function runPrivateScheduledRehearsal({ hostConfigFile, stageReceiptFile,
  secretsDirectory, outputDirectory, profileId, vacancyId, execute = false,
  fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  if (!execute || ![hostConfigFile, stageReceiptFile, secretsDirectory, outputDirectory].every(absolute) ||
      !safeId(profileId) || !safeId(vacancyId) || typeof fetchImpl !== 'function' || typeof clock !== 'function') fail();
  const host = loadPrivateHostConfig(hostConfigFile);
  if (!host.isVacancyOwned(profileId, vacancyId)) fail();
  const stage = readPrivateJson(stageReceiptFile, 1024 * 1024);
  if (stage?.version !== 'r03-private-schedule-stage-v1' || stage.status !== 'disposable_only' ||
      stage.sourceDbPath !== host.dbPath || stage.stagedDbPath !== join(dirname(stageReceiptFile), 'candidate.sqlite') ||
      stage.stagedDbPath === host.dbPath || stage.imported !== 11 || stage.unknownQuarantined !== 8 || stage.enabled !== 0 ||
      outputDirectory === dirname(stageReceiptFile) || outputDirectory === dirname(host.dbPath)) fail();
  privateDirectory(dirname(outputDirectory));
  const sourceInfo = lstatSync(host.dbPath);
  const stagedInfo = lstatSync(stage.stagedDbPath);
  if (![sourceInfo, stagedInfo].every(info => info.isFile() && !(info.mode & 0o077) && info.uid === process.getuid())) fail();
  const receiptFile = join(outputDirectory, 'receipt.json');
  if (existsSync(outputDirectory)) {
    privateDirectory(outputDirectory);
    if (!existsSync(receiptFile)) fail(); // Crash after dispatch is uncertain: no automatic repeat.
    const prior = readPrivateJson(receiptFile, 1024 * 1024);
    if (prior?.version !== 'r03-private-scheduled-rehearsal-v1' || prior.disposition !== 'partial_rehearsal' ||
        prior.migrationId !== stage.migrationId || prior.profileId !== profileId || prior.vacancyId !== vacancyId ||
        prior.stageDbPath !== stage.stagedDbPath || JSON.stringify(prior.limits) !== JSON.stringify(limits)) fail();
    const db = new Database(join(outputDirectory, 'candidate.sqlite'), { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT payload FROM cold_search_occurrences WHERE occurrence_id=?').get(prior.occurrenceId);
      const occurrence = row && JSON.parse(row.payload);
      if (occurrence?.status !== prior.occurrenceStatus || occurrence?.jobId !== prior.jobId) fail();
      if (prior.occurrenceStatus === 'succeeded') {
        const snapshot = db.prepare(`SELECT candidate_count FROM real_hh_snapshot
          WHERE job_id=? AND profile_id=? AND vacancy_id=?`).get(prior.jobId, profileId, vacancyId);
        if (snapshot?.candidate_count !== prior.candidateCount) fail();
      }
    } finally { db.close(); }
    return { status: 'replayed', originalStatus: prior.occurrenceStatus,
      providerRequests: 0, assessmentRequests: 0,
      assessmentFailed: prior.assessmentFailed, acceptedForMorning: false,
      disposition: 'partial_rehearsal', disposableOnly: true };
  }
  const sourceBefore = await digestPrivateFile(host.dbPath, 1024 * 1024 * 1024);
  const stagedBefore = await digestPrivateFile(stage.stagedDbPath, 1024 * 1024 * 1024);
  const source = new Database(stage.stagedDbPath, { readonly: true, fileMustExist: true });
  try {
    const counts = source.prepare(`SELECT COUNT(*) AS n, SUM(enabled) AS enabled
      FROM cold_search_schedules`).get();
    const unknown = source.prepare('SELECT payload FROM cold_search_schedules').all()
      .filter(row => JSON.parse(row.payload).migrationQuarantine?.reason === 'legacy_outcome_unknown').length;
    if (counts.n !== 11 || counts.enabled !== 0 || unknown !== 8 ||
        source.prepare('SELECT COUNT(*) AS n FROM cold_search_occurrences').get().n !== 0) fail();
    mkdirSync(outputDirectory, { mode: 0o700 });
    await source.backup(join(outputDirectory, 'candidate.sqlite'));
  } finally { source.close(); }
  const filename = join(outputDirectory, 'candidate.sqlite');
  chmodSync(filename, 0o600);
  const schedules = new SqliteColdSearchScheduleRepository(filename);
  const candidates = new SqliteRealHhCandidateState({ filename, isVacancyOwned: host.isVacancyOwned });
  let providerRequests = 0;
  let assessmentRequests = 0;
  let providerPages = null;
  try {
    const baseLoad = createPrivateBaseSearchPlan({ resolveProfileBinding: host.resolveProfileBinding,
      isVacancyOwned: host.isVacancyOwned });
    const base = await baseLoad(profileId, vacancyId, { allowGeneration: false });
    if (base.queryCache.pendingGeneration || !base.queryCache.queries.length) fail();
    const plan = { ...base, queryCache: { ...base.queryCache,
      queries: [base.queryCache.queries[0]],
      revision: `scheduled-rehearsal-${digest([base.queryCache.revision, base.queryCache.queries[0]]).slice(0, 24)}` } };
    const loadSearchPlan = async (requestedProfile, requestedVacancy) => {
      const current = await baseLoad(requestedProfile, requestedVacancy, { allowGeneration: false });
      if (current.profileId !== profileId || current.vacancyId !== vacancyId ||
          current.criteriaRevision !== base.criteriaRevision ||
          current.queryCache.revision !== base.queryCache.revision ||
          current.queryCache.queries[0] !== base.queryCache.queries[0]) fail();
      return plan;
    };
    const encryptionKey = loadPrivateHostSecret(secretsDirectory, 'hh_encryption_key');
    if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) fail();
    const credentials = createPrivateHhCredentialBroker({ resolveProfileBinding: host.resolveProfileBinding,
      encryptionKey, fetchImpl });
    await credentials.loadCredential(profileId);
    const userAgent = loadPrivateHostSecret(secretsDirectory, 'hh_user_agent');
    const boundedFetch = async (url, init) => {
      if (++providerRequests > 1 || init?.method !== 'GET' ||
          new URL(url).origin !== 'https://api.hh.ru' || new URL(url).pathname !== '/resumes' ||
          new URL(url).searchParams.get('page') !== '0' ||
          new URL(url).searchParams.get('per_page') !== '1') fail();
      return fetchImpl(url, init);
    };
    const transport = createHhResumeTransport({
      loadVacancyContext: async (p, v) => ({ profileId: p, vacancyId: v, config: plan.atsConfig }),
      loadCredential: credentials.loadCredential, fetchImpl: boundedFetch, userAgent,
      pageLimit: 1, perPage: 1, maxAttempts: 1, allowPartialWindow: true });
    const onePage = { search: async input => {
      const result = await transport.search(input);
      providerPages = result.pages;
      return result;
    } };
    const search = createOfflineHhColdSearch({ loadSearchPlan, transport: onePage,
      candidateState: candidates, clock });
    const worker = createDurableHhOccurrenceWorker({ scheduleRepository: schedules,
      loadSearchPlan, search, candidateState: candidates, clock });
    const now = clock().toISOString();
    const schedulePlan = intervalPlan(24, vacancyId);
    const key = digest([stage.migrationId, profileId, vacancyId, now]).slice(0, 24);
    const rehearsalScheduleId = `rehearsal_schedule_${key}`;
    schedules.upsertSchedule({ scheduleId: rehearsalScheduleId, legacyJobId: `rehearsal_job_${key}`,
      profileId, vacancyId, enabled: true, plan: schedulePlan, timezone: 'Europe/Moscow',
      jobArguments: { vacancyId }, nextRunAt: nextOccurrenceAfter(schedulePlan,
        new Date(Date.parse(now) - 48 * 60 * 60_000).toISOString()),
      leaseOwner: null, leaseUntil: null, blockedByUnknownOccurrenceId: null });
    const tick = await runPrivateHhMinuteTick({ worker, scheduleRepository: schedules,
      workerId: `rehearsal_worker_${key}`, clock });
    const occurrence = schedules.listOccurrences(profileId).filter(row => row.scheduleId === rehearsalScheduleId);
    if (occurrence.length !== 1 || tick.result?.claimed !== 1) fail();
    const synthetic = schedules.getSchedule(rehearsalScheduleId);
    schedules.persistSchedule({ ...synthetic, enabled: false,
      blockedByUnknownOccurrenceId: `partial_rehearsal_${key}`,
      migrationQuarantine: { reason: 'partial_rehearsal', migrationId: stage.migrationId } });
    let scoring = { status: 'held', written: 0, failed: 0 };
    if (occurrence[0].status === 'succeeded' && candidates.assessedResultPage({ profileId,
      vacancyId, jobId: occurrence[0].jobId, limit: 1 })?.snapshot?.candidateCount) {
      const ladderToken = loadPrivateHostSecret(secretsDirectory, 'ladder_token');
      const chat = createFreeLadderChat({ loadToken: async () => ladderToken,
        fetchImpl: async (url, init) => {
          if (++assessmentRequests > 1 || new URL(url).origin !== 'https://llm-ladder.trainedassist.store' ||
              init?.method !== 'POST') fail();
          return fetchImpl(url, init);
        } });
      const evaluate = createHhAssessmentEvaluator({ loadSearchPlan, chat });
      scoring = await runAcceptedMorningScoringTick({ worker, state: candidates,
        trustedContext: { profileId, scopes: ['recruiting.candidateSearch'] }, vacancyId,
        evaluate, currentCriteriaRevision: async () => plan.criteriaRevision, now: clock, limit: 1 });
    }
    const morning = worker.morningResults({ profileId,
      scopes: ['recruiting.candidateSearch'] }, vacancyId, { limit: 1 });
    const stillDisabled = schedules.listAllSchedules().filter(row => row.scheduleId !== rehearsalScheduleId);
    if (stillDisabled.length !== 11 || stillDisabled.some(row => row.enabled || !row.blockedByUnknownOccurrenceId) ||
        schedules.db.pragma('integrity_check', { simple: true }) !== 'ok') fail();
    const receipt = { version: 'r03-private-scheduled-rehearsal-v1', disposition: 'partial_rehearsal',
      migrationId: stage.migrationId, stageDbPath: stage.stagedDbPath, profileId, vacancyId,
      limits, occurrenceId: occurrence[0].occurrenceId, occurrenceStatus: occurrence[0].status,
      jobId: occurrence[0].jobId, candidateCount: morning.snapshot?.candidateCount ?? 0,
      newCount: morning.snapshot?.newCount ?? 0, providerRequests, providerPages,
      assessmentRequests, assessmentWritten: scoring.written ?? 0,
      assessmentFailed: scoring.failed ?? 0, freshness: 'not_accepted_partial',
      acceptedForMorning: false, fullQuerySet: false, fullPagination: false };
    const [sourceAfter, stagedAfter] = await Promise.all([
      digestPrivateFile(host.dbPath, 1024 * 1024 * 1024),
      digestPrivateFile(stage.stagedDbPath, 1024 * 1024 * 1024)
    ]);
    if (sourceAfter.sha256 !== sourceBefore.sha256 || stagedAfter.sha256 !== stagedBefore.sha256) fail();
    writeFileSync(receiptFile, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: occurrence[0].status, providerRequests, assessmentRequests,
      candidateCount: receipt.candidateCount, newCount: receipt.newCount,
      assessmentWritten: receipt.assessmentWritten,
      assessmentFailed: receipt.assessmentFailed,
      acceptedForMorning: false, disposition: 'partial_rehearsal',
      freshness: receipt.freshness,
      disposableOnly: true };
  } finally { candidates.close(); schedules.close(); }
}

function args(argv) {
  const map = { '--host-config': 'hostConfigFile', '--stage-receipt': 'stageReceiptFile',
    '--secrets': 'secretsDirectory', '--output-directory': 'outputDirectory',
    '--profile': 'profileId', '--vacancy': 'vacancyId' };
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
    const result = await runPrivateScheduledRehearsal(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_scheduled_rehearsal', ...result }) + '\n');
    if (result.status !== 'succeeded' &&
        !(result.status === 'replayed' && result.originalStatus === 'succeeded')) process.exitCode = 2;
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_scheduled_rehearsal', status: 'failed',
      code: 'private_scheduled_rehearsal_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
