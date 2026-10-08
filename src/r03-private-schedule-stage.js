import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { digestPrivateFile, privateDirectory, readPrivateJson } from './r03-private-legacy-archive.js';
import { loadPrivateHostConfig } from './r03-private-host-config.js';
import { SqliteColdSearchScheduleRepository } from './sqlite-cold-search-schedule-repository.js';
import { R03LegacyScheduleImport } from './r03-legacy-schedule-import.js';

const fail = () => { throw new Error('private_schedule_stage_unavailable'); };
const absolute = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path;

// A new disposable SQLite copy is the only mutation target. The frozen cron
// DB and imported migration DB are opened read-only. All 11 definitions stay
// disabled and blocked, including the eight unresolved legacy outcomes.
export async function stagePrivateLegacySchedules({ hostConfigFile, importConfigFile,
  cronDbPath, cronManifestPath, unknownReceiptFile, outputDirectory,
  clock = () => new Date() } = {}) {
  if (![hostConfigFile, importConfigFile, cronDbPath, cronManifestPath,
    unknownReceiptFile, outputDirectory].every(absolute) || typeof clock !== 'function') fail();
  privateDirectory(dirname(outputDirectory));
  const host = loadPrivateHostConfig(hostConfigFile);
  const source = readPrivateJson(importConfigFile, 1024 * 1024);
  if (typeof source?.manifestPath !== 'string') fail();
  const archiveManifest = readPrivateJson(source.manifestPath, 1024 * 1024);
  const cronManifest = readPrivateJson(cronManifestPath, 1024 * 1024);
  const audit = readPrivateJson(unknownReceiptFile, 16 * 1024 * 1024);
  if (source?.version !== 'r03-private-legacy-import-v1' || source.targetDbPath !== host.dbPath ||
      archiveManifest?.kind !== 'final_frozen' || archiveManifest.migrationId !== source.migrationId ||
      archiveManifest.sha256 !== source.archiveSha256 || archiveManifest.bytes !== source.archiveBytes ||
      cronManifest?.kind !== 'cron_frozen' || cronManifest.hhCronDefinitions !== 11 ||
      cronManifest.unknown !== 8 || cronManifest.enabled !== 0 ||
      audit?.version !== 'r03-private-unknown-audit-v1' ||
      audit.migrationId !== source.migrationId || audit.archiveSha256 !== source.archiveSha256 ||
      audit.cronSha256 !== cronManifest.sha256 || audit.jobs?.length !== 8 ||
      audit.jobs.some(row => row.disposition !== 'quarantined_ambiguous')) fail();
  const [cronDigest, archiveDigest] = await Promise.all([
    digestPrivateFile(cronDbPath, 1024 * 1024 * 1024),
    digestPrivateFile(source.archivePath, 1024 * 1024 * 1024)
  ]);
  if (cronDigest.sha256 !== cronManifest.sha256 || cronDigest.bytes !== cronManifest.bytes ||
      archiveDigest.sha256 !== source.archiveSha256 || archiveDigest.bytes !== source.archiveBytes) fail();
  const sourceInfo = lstatSync(host.dbPath);
  if (!sourceInfo.isFile() || sourceInfo.mode & 0o077 || sourceInfo.uid !== process.getuid()) fail();
  const cron = new Database(cronDbPath, { readonly: true, fileMustExist: true });
  let rows;
  try { rows = cron.prepare(`SELECT id,profile_id,name,schedule,timezone,action,
    arguments_json,enabled,last_status FROM cron_jobs WHERE action='hh_proactive_search'`).all(); }
  finally { cron.close(); }
  if (rows.length !== 11 || rows.some(row => row.enabled !== 0) ||
      rows.filter(row => row.last_status === 'unknown').length !== 8) fail();
  const audited = new Map(audit.jobs.map(row => [row.legacyJobId, row]));
  if (audited.size !== 8 || rows.filter(row => row.last_status === 'unknown').some(row =>
    audited.get(row.id)?.profileId !== host.resolveLegacyProfile(row.profile_id))) fail();
  const definitions = rows.map(row => {
    let args;
    try { args = JSON.parse(row.arguments_json); } catch { fail(); }
    return { legacyJobId: row.id, sourceProfileRef: row.profile_id,
      vacancyId: String(args?.vacancy_id ?? ''), name: row.name, action: row.action,
      arguments: args, cron: row.schedule, timezone: row.timezone,
      enabled: false, lastStatus: row.last_status };
  });
  const envelope = { version: 'legacy-hh-schedules-v1', migrationId: source.migrationId,
    definitions };
  let created = false;
  try {
    mkdirSync(outputDirectory, { mode: 0o700 }); created = true;
    const dbPath = join(outputDirectory, 'candidate.sqlite');
    const imported = new Database(host.dbPath, { readonly: true, fileMustExist: true });
    try { await imported.backup(dbPath); } finally { imported.close(); }
    chmodSync(dbPath, 0o600);
    const schedules = new SqliteColdSearchScheduleRepository(dbPath);
    let summary;
    try {
      const importer = new R03LegacyScheduleImport({ repository: schedules,
        bindProfile: host.resolveLegacyProfile, isVacancyOwned: host.isVacancyOwned, clock });
      summary = importer.import(envelope);
      const stored = schedules.listAllSchedules();
      if (summary.imported !== 11 || summary.unknown !== 8 || stored.length !== 11 ||
          stored.some(row => row.enabled || !row.blockedByUnknownOccurrenceId ||
            !row.migrationQuarantine) ||
          schedules.db.pragma('integrity_check', { simple: true }) !== 'ok') fail();
    } finally { schedules.close(); }
    const receipt = { version: 'r03-private-schedule-stage-v1', migrationId: source.migrationId,
      sourceArchiveSha256: source.archiveSha256, cronSha256: cronDigest.sha256,
      unknownAuditSha256: (await digestPrivateFile(unknownReceiptFile, 16 * 1024 * 1024)).sha256,
      sourceDbPath: host.dbPath, stagedDbPath: dbPath, imported: 11,
      unknownQuarantined: 8, enabled: 0, status: 'disposable_only' };
    writeFileSync(join(outputDirectory, 'receipt.json'), JSON.stringify(receipt) + '\n',
      { flag: 'wx', mode: 0o600 });
    return { status: 'staged', imported: 11, unknownQuarantined: 8, enabled: 0 };
  } catch (error) {
    if (created) rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

function args(argv) {
  const map = { '--host-config': 'hostConfigFile', '--import-config': 'importConfigFile',
    '--cron-db': 'cronDbPath', '--cron-manifest': 'cronManifestPath',
    '--unknown-receipt': 'unknownReceiptFile', '--output-directory': 'outputDirectory' };
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const field = map[argv[i]];
    if (!field || out[field] !== undefined) fail();
    out[field] = argv[++i];
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await stagePrivateLegacySchedules(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_schedule_stage', ...result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_schedule_stage', status: 'failed',
      code: 'private_schedule_stage_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
