import { createRequire } from 'node:module';
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// All identifiers remain in a root-owned receipt. The journal gets aggregate
// status only. The source cron DB and imported stage are read-only throughout.
const [mode, releaseDirectory, hostConfigFile, stageReceiptFile, cronDbPath,
  secretsDirectory, dispositionFile, selectionFile, preflightFile,
  outputDirectory, expectedAt] = process.argv.slice(2);
const absolute = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
const fail = () => { throw new Error('natural_cycle_canary_unavailable'); };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const owned = path => {
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) fail();
};
let exitCode = 0;
try {
  if (!['review', 'prepare', 'preflight', 'run', 'replay'].includes(mode) ||
      ![releaseDirectory, hostConfigFile, stageReceiptFile, cronDbPath, secretsDirectory,
        dispositionFile, selectionFile, preflightFile, outputDirectory].every(absolute) ||
      !Number.isFinite(Date.parse(expectedAt))) fail();
  const stage = readJson(stageReceiptFile);
  if (stage.version !== 'r03-private-schedule-stage-v1' || stage.status !== 'disposable_only' ||
      stage.imported !== 11 || stage.unknownQuarantined !== 8 || stage.enabled !== 0 ||
      stage.stagedDbPath !== join(dirname(stageReceiptFile), 'candidate.sqlite') ||
      outputDirectory === dirname(stageReceiptFile) ||
      sha256(cronDbPath) !== stage.cronSha256) fail();
  for (const path of [stage.stagedDbPath, stage.sourceDbPath, cronDbPath]) owned(path);
  const require = createRequire(join(releaseDirectory, 'package.json'));
  const Database = require('better-sqlite3');
  const { loadPrivateHostConfig } = await import(pathToFileURL(
    join(releaseDirectory, 'src/r03-private-host-config.js')).href);
  const host = loadPrivateHostConfig(hostConfigFile);
  if (host.dbPath !== stage.sourceDbPath) fail();
  const { legacyCronToPlan } = await import(pathToFileURL(
    join(releaseDirectory, 'src/r03-legacy-schedule-import.js')).href);
  const staged = new Database(stage.stagedDbPath, { readonly: true, fileMustExist: true });
  const cron = new Database(cronDbPath, { readonly: true, fileMustExist: true });
  let selected;
  let history;
  try {
    const rows = staged.prepare('SELECT payload FROM cold_search_schedules').all()
      .map(row => JSON.parse(row.payload));
    const frozen = cron.prepare(`SELECT COUNT(*) AS n,SUM(enabled) AS enabled
      FROM cron_jobs WHERE action='hh_proactive_search'`).get();
    if (rows.length !== 11 || rows.some(row => row.enabled || !row.blockedByUnknownOccurrenceId) ||
        rows.filter(row => row.migrationQuarantine?.reason === 'legacy_outcome_unknown').length !== 8 ||
        frozen.n !== 11 || frozen.enabled !== 0 ||
        staged.prepare('SELECT COUNT(*) AS n FROM cold_search_occurrences').get().n !== 0) fail();
    const matches = rows.filter(row => row.nextRunAt === expectedAt &&
      row.plan?.intervalHours === 24 && row.migrationQuarantine?.reason === 'cutover_review_required' &&
      row.timezone === 'Europe/Moscow' && host.isVacancyOwned(row.profileId, row.vacancyId));
    if (matches.length !== 1) fail();
    selected = matches[0];
    const legacy = cron.prepare(`SELECT profile_id,schedule,timezone,action,arguments_json,
      enabled,last_status FROM cron_jobs WHERE id=?`).get(selected.legacyJobId);
    if (!legacy || legacy.enabled !== 0 || legacy.last_status !== 'succeeded' ||
        legacy.schedule !== selected.legacyCron || legacy.timezone !== selected.timezone ||
        legacy.action !== 'hh_proactive_search' ||
        host.resolveLegacyProfile(legacy.profile_id) !== selected.profileId ||
        JSON.parse(legacy.arguments_json)?.vacancy_id !== selected.vacancyId ||
        JSON.stringify(legacyCronToPlan(legacy.schedule)) !== JSON.stringify(selected.plan)) fail();
    // Last status can hide an earlier ambiguous effect. Preserve every
    // historical occurrence as frozen evidence; only a new future slot runs.
    history = cron.prepare(`SELECT id,status,scheduled_at FROM action_executions
      WHERE cron_id=? ORDER BY scheduled_at,id`).all(selected.legacyJobId);
    if (!history.length || history.some(row => !['succeeded', 'unknown'].includes(row.status) ||
        typeof row.id !== 'string' || !Number.isSafeInteger(row.scheduled_at))) fail();
  } finally { staged.close(); cron.close(); }
  const { createPrivateBaseSearchPlan } = await import(pathToFileURL(
    join(releaseDirectory, 'src/r03-private-base-plan.js')).href);
  const loadPlan = createPrivateBaseSearchPlan({ resolveProfileBinding: host.resolveProfileBinding,
    isVacancyOwned: host.isVacancyOwned });
  const plan = await loadPlan(selected.profileId, selected.vacancyId, { allowGeneration: false });
  if (plan.queryCache.pendingGeneration || plan.queryCache.queries.length !== 7) fail();
  const unknown = history.filter(row => row.status === 'unknown');
  if (history.some(row => row.scheduled_at >= Date.parse(expectedAt)) ||
      unknown.some(row =>
      !history.some(later => later.status === 'succeeded' &&
        later.scheduled_at > row.scheduled_at))) fail();
  const disposition = { version: 'r03-private-historical-unknown-disposition-v1',
    decision: 'quarantine_old_unknown_no_replay_new_disposable_slot_only',
    historicalOutcome: 'unresolved', migrationId: stage.migrationId,
    cronSha256: stage.cronSha256, stageDbSha256: sha256(stage.stagedDbPath),
    sourceDbSha256: sha256(stage.sourceDbPath), legacyJobId: selected.legacyJobId,
    unknownActionIds: unknown.map(row => row.id),
    unknownScheduledAt: unknown.map(row => row.scheduled_at), expectedAt };
  if (mode === 'review') {
    if (!unknown.length || existsSync(dispositionFile) || existsSync(selectionFile) ||
        existsSync(preflightFile) || existsSync(outputDirectory) ||
        Date.parse(expectedAt) <= Date.now() + 20 * 60_000) fail();
    writeFileSync(dispositionFile, JSON.stringify(disposition) + '\n',
      { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ event: 'r03.natural_cycle_review',
      status: 'quarantined_no_replay', historicalUnknown: unknown.length,
      laterSucceeded: true, expectedAt, disposableOnly: true }) + '\n');
  } else {
  if (unknown.length) {
    owned(dispositionFile);
    if (JSON.stringify(readJson(dispositionFile)) !== JSON.stringify(disposition)) fail();
  } else if (existsSync(dispositionFile)) fail();
  const selection = { version: 'r03-private-natural-cycle-selection-v1',
    migrationId: stage.migrationId, stageDbSha256: sha256(stage.stagedDbPath),
    sourceDbSha256: sha256(stage.sourceDbPath), cronSha256: stage.cronSha256,
    scheduleId: selected.scheduleId, legacyJobId: selected.legacyJobId,
    profileId: selected.profileId, vacancyId: selected.vacancyId, expectedAt,
    criteriaRevision: plan.criteriaRevision, queryRevision: plan.queryCache.revision,
    disposition: unknown.length ? 'old_unknown_quarantined_future_disposable_only' :
      'reviewed_succeeded_disposable_only',
    dispositionSha256: unknown.length ? sha256(dispositionFile) : null };
  if (mode === 'prepare') {
    if (existsSync(selectionFile) || existsSync(preflightFile) || existsSync(outputDirectory) ||
        Date.parse(expectedAt) <= Date.now() + 20 * 60_000) fail();
    owned(hostConfigFile); owned(stageReceiptFile);
    writeFileSync(selectionFile, JSON.stringify(selection) + '\n', { flag: 'wx', mode: 0o600 });
    chmodSync(selectionFile, 0o600);
    process.stdout.write(JSON.stringify({ event: 'r03.natural_cycle_prepare', status: 'ready',
      expectedAt, intervalHours: 24, queryCount: 7, disposableOnly: true }) + '\n');
  } else {
    owned(selectionFile);
    const saved = readJson(selectionFile);
    if (JSON.stringify(saved) !== JSON.stringify(selection)) fail();
    if (mode === 'preflight') {
      if (existsSync(preflightFile) || existsSync(outputDirectory) ||
          Date.now() < Date.parse(expectedAt) - 14 * 60_000 ||
          Date.now() >= Date.parse(expectedAt)) fail();
      const { runPrivateFullCostPreflight } = await import(pathToFileURL(
        join(releaseDirectory, 'src/r03-private-full-cost-preflight.js')).href);
      const result = await runPrivateFullCostPreflight({ hostConfigFile, stageReceiptFile,
        secretsDirectory, outputFile: preflightFile, profileId: selected.profileId,
        vacancyId: selected.vacancyId, execute: true });
      const ready = result.status === 'ready' && result.estimatedRequests <= 80 &&
        result.rawItemUpperBound <= 3000;
      process.stdout.write(JSON.stringify({ event: 'r03.natural_cycle_preflight',
        status: ready ? 'ready' : 'blocked', queryCount: result.queryCount,
        requests: result.requests, estimatedRequests: result.estimatedRequests,
        rawItemUpperBound: result.rawItemUpperBound }) + '\n');
      if (!ready) exitCode = 2;
    } else {
      owned(preflightFile);
      const preflight = readJson(preflightFile);
      if (preflight.version !== 'r03-full-discovery-cost-preflight-v1' ||
          preflight.status !== 'ready' || preflight.profileId !== selected.profileId ||
          preflight.vacancyId !== selected.vacancyId ||
          preflight.criteriaRevision !== plan.criteriaRevision ||
          preflight.queryRevision !== plan.queryCache.revision ||
          preflight.estimatedRequests > 80 || preflight.rawItemUpperBound > 3000 ||
          !Number.isFinite(Date.parse(preflight.at)) ||
          Date.parse(preflight.at) >= Date.parse(expectedAt) ||
          Date.parse(expectedAt) - Date.parse(preflight.at) > 15 * 60_000) fail();
      const { runPrivateFullDiscoveryRehearsal } = await import(pathToFileURL(
        join(releaseDirectory, 'src/r03-private-full-discovery-rehearsal.js')).href);
      const result = await runPrivateFullDiscoveryRehearsal({ hostConfigFile, stageReceiptFile,
        preflightReceiptFile: preflightFile, secretsDirectory, outputDirectory,
        profileId: selected.profileId, vacancyId: selected.vacancyId,
        naturalScheduleId: selected.scheduleId, expectedNaturalAt: expectedAt, execute: true });
      const accepted = result.status === 'succeeded' ||
        result.status === 'replayed' && result.originalStatus === 'succeeded';
      process.stdout.write(JSON.stringify({ event: 'r03.natural_cycle_' + mode,
        status: result.status, providerRequests: result.providerRequests,
        assessmentRequests: result.assessmentRequests, queryCount: result.queryCount,
        candidateCount: result.candidateCount, disposableDiscoveryComplete: result.disposableDiscoveryComplete,
        published: result.published, expectedAt, disposableOnly: true }) + '\n');
      if (!accepted) exitCode = 2;
    }
  }
  }
} catch {
  process.stdout.write(JSON.stringify({ event: 'r03.natural_cycle_' + mode, status: 'failed' }) + '\n');
  exitCode = 78;
}
process.exitCode = exitCode;
