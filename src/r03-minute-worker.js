import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRecruitingServer } from './server.js';
import { digest, syntheticColdSearchProvider } from './candidate-search-jobs.js';
import { validSearchContext } from './cold-search-schedules.js';
import { SqliteColdSearchScheduleRepository } from './sqlite-cold-search-schedule-repository.js';
import { SqliteCandidateSearchJobs } from './sqlite-candidate-search-jobs.js';
import { SqliteCandidateStateStore } from './sqlite-candidate-state.js';
import { SqliteMinuteWorkerLease } from './sqlite-minute-worker-lease.js';

const LEASE_MS = 5 * 60_000;
const MAX_RUN_MS = 4 * 60_000;
const fixtureUrl = new URL('../fixtures/r03-worker-synthetic.json', import.meta.url);
const fixtureKey = (profileId, vacancyId) => JSON.stringify([profileId, vacancyId]);

export async function loadSyntheticWorkerBindings() {
  const raw = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  if (raw?.kind !== 'r03-synthetic-worker-fixture-v1' || !Array.isArray(raw.bindings) || raw.bindings.length !== 1) throw new Error('invalid_synthetic_fixture');
  const bindings = new Map();
  for (const row of raw.bindings) {
    if (!row || Object.keys(row).sort().join(',') !== 'criteria,criteriaRevision,profileId,vacancyId' ||
        row.profileId !== 'profile_demo_001' || row.vacancyId !== 'vac_demo_001' || !validSearchContext(row, row.vacancyId)) throw new Error('invalid_synthetic_fixture');
    const key = fixtureKey(row.profileId, row.vacancyId);
    if (bindings.has(key)) throw new Error('duplicate_synthetic_binding');
    bindings.set(key, { vacancyId: row.vacancyId, criteriaRevision: row.criteriaRevision, criteria: row.criteria });
  }
  return bindings;
}

function preflightSchedules(repository, bindings) {
  const enabled = repository.listAllSchedules().filter(row => row.enabled);
  for (const schedule of enabled) {
    const expectedJobId = `cold-search:${digest(schedule.profileId).slice(0, 10)}:${schedule.vacancyId}`;
    if (!bindings.has(fixtureKey(schedule.profileId, schedule.vacancyId)) ||
        schedule.legacyJobId !== expectedJobId || schedule.timezone !== 'Europe/Moscow' ||
        schedule.jobArguments?.vacancyId !== schedule.vacancyId) throw new Error('unbound_enabled_schedule');
  }
  return enabled.length;
}

export async function runSyntheticMinuteWorker({ dbPath, clock = () => new Date(), checkOnly = false, log = () => {} }) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') throw new TypeError('database_path_required');
  const bindings = await loadSyntheticWorkerBindings();
  const scheduleRepository = new SqliteColdSearchScheduleRepository(dbPath);
  let jobStore;
  let candidateStateStore;
  try {
    const enabledScheduleCount = preflightSchedules(scheduleRepository, bindings);
    jobStore = new SqliteCandidateSearchJobs({ filename: dbPath, provider: syntheticColdSearchProvider, clock, dispatchLeaseMs: LEASE_MS });
    candidateStateStore = new SqliteCandidateStateStore({ filename: dbPath });
    if (checkOnly) {
      const blockedScheduleCount = scheduleRepository.listAllSchedules().filter(row => row.enabled && row.blockedByUnknownOccurrenceId).length;
      const expiredDispatchCount = jobStore.countExpiredDispatches();
      const outcome = { event: 'r03.worker.ready', mode: 'synthetic', status: blockedScheduleCount || expiredDispatchCount ? 'degraded' : 'ready', enabledScheduleCount, blockedScheduleCount, expiredDispatchCount };
      log(outcome);
      return outcome;
    }
    const workerId = randomUUID();
    const now = clock().toISOString();
    const lease = new SqliteMinuteWorkerLease(scheduleRepository.db);
    const acquired = lease.acquire({ owner: workerId, now, expiresAt: new Date(Date.parse(now) + LEASE_MS).toISOString() });
    if (!acquired) {
      const outcome = { event: 'r03.worker.skipped', reason: 'runner_busy' };
      log(outcome);
      return outcome;
    }
    const started = Date.now();
    try {
      const recoveredUnknownJobs = jobStore.quarantineExpiredDispatches();
      const searchRequest = async (profileId, vacancyId) => bindings.get(fixtureKey(profileId, vacancyId)) ?? null;
      const server = createRecruitingServer({
        candidateSearchScheduleRepository: scheduleRepository,
        candidateSearchJobStore: jobStore,
        candidateStateStore,
        resolveScheduledSearchRequest: searchRequest,
        resolveCurrentSearchCriteriaRevision: async (_context, vacancyId) => bindings.get(fixtureKey(_context.profileId, vacancyId))?.criteriaRevision ?? null,
        scheduleClock: clock,
        scheduleLeaseMs: LEASE_MS
      });
      const result = await server.coldSearchSchedules.tick(workerId);
      const blockedScheduleCount = scheduleRepository.listAllSchedules().filter(row => row.enabled && row.blockedByUnknownOccurrenceId).length;
      const outcome = { event: 'r03.worker.tick', mode: 'synthetic', claimed: result.claimed,
        completed: result.completed, unknown: result.unknown, recoveredUnknownJobs, blockedScheduleCount, durationMs: Date.now() - started };
      log(outcome);
      return outcome;
    } finally { lease.release(workerId); }
  } finally {
    if (candidateStateStore?.db.open) candidateStateStore.close();
    if (jobStore?.db.open) jobStore.close();
    if (scheduleRepository.db.open) scheduleRepository.close();
  }
}

function parseArgs(args) {
  const flags = new Set();
  let dbPath;
  let at;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--once', '--check', '--synthetic-fixture', '--synthetic-dry-run'].includes(arg)) {
      if (flags.has(arg)) throw new Error('duplicate_argument');
      flags.add(arg);
    } else if (arg === '--db' && !dbPath) dbPath = args[++i];
    else if (arg === '--at' && !at) at = args[++i];
    else throw new Error('invalid_argument');
  }
  if (!dbPath || !flags.has('--synthetic-fixture') || !flags.has('--synthetic-dry-run') ||
      Number(flags.has('--once')) + Number(flags.has('--check')) !== 1) throw new Error('synthetic_mode_explicitly_required');
  if (at && new Date(at).toISOString() !== at) throw new Error('invalid_clock');
  return { dbPath: resolve(dbPath), checkOnly: flags.has('--check'), clock: at ? () => new Date(at) : () => new Date() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const emit = row => process.stdout.write(`${JSON.stringify(row)}\n`);
  let watchdog;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.checkOnly) watchdog = setTimeout(() => {
      emit({ event: 'r03.worker.timeout', mode: 'synthetic', maxRunMs: MAX_RUN_MS });
      process.exit(124);
    }, MAX_RUN_MS);
    const outcome = await runSyntheticMinuteWorker({ ...options, log: emit });
    if (outcome.status === 'degraded' || outcome.unknown > 0 || outcome.recoveredUnknownJobs > 0 || outcome.blockedScheduleCount > 0) process.exitCode = 2;
  } catch (error) {
    emit({ event: 'r03.worker.error', code: ['unbound_enabled_schedule', 'invalid_synthetic_fixture', 'duplicate_synthetic_binding'].includes(error.message) ? error.message : 'configuration_or_storage_error' });
    process.exitCode = 78;
  } finally { if (watchdog) clearTimeout(watchdog); }
}
