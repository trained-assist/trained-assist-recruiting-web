import { createHash } from 'node:crypto';
import { lstatSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { digestPrivateFile, privateBytes, privateDirectory, readPrivateJson } from './r03-private-legacy-archive.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sha = value => createHash('sha256').update(value ?? '').digest('hex');
const fail = () => { throw new Error('private_unknown_audit_unavailable'); };

// Historical unknowns are evidence, not a dispatch command. A source snapshot
// has no trustworthy occurrence/job receipt, so proximity to a slot cannot
// authorize either replay or accepted publication.
export async function auditPrivateLegacyUnknowns({ importConfigFile, cronDbPath,
  cronManifestPath, outputFile } = {}) {
  for (const path of [importConfigFile, cronDbPath, cronManifestPath, outputFile])
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail();
  privateDirectory(dirname(outputFile));
  const source = readPrivateJson(importConfigFile, 1024 * 1024);
  if (!source || typeof source.manifestPath !== 'string') fail();
  const archiveManifest = readPrivateJson(source.manifestPath, 1024 * 1024);
  const cronManifest = readPrivateJson(cronManifestPath, 1024 * 1024);
  if (source?.version !== 'r03-private-legacy-import-v1' || !safeId(source.migrationId) ||
      !Array.isArray(source.profiles) || !/^[a-f0-9]{64}$/.test(source.archiveSha256) ||
      archiveManifest?.kind !== 'final_frozen' || archiveManifest.migrationId !== source.migrationId ||
      archiveManifest.sha256 !== source.archiveSha256 || archiveManifest.bytes !== source.archiveBytes ||
      cronManifest?.kind !== 'cron_frozen' || !/^[a-f0-9]{64}$/.test(cronManifest.sha256) ||
      cronManifest.unknown !== 8 || cronManifest.enabled !== 0) fail();
  const [archive, cron] = await Promise.all([
    digestPrivateFile(source.archivePath, 1024 * 1024 * 1024),
    digestPrivateFile(cronDbPath, 1024 * 1024 * 1024)
  ]);
  if (archive.sha256 !== source.archiveSha256 || archive.bytes !== source.archiveBytes ||
      cron.sha256 !== cronManifest.sha256 || cron.bytes !== cronManifest.bytes) fail();
  privateDirectory(dirname(source.targetDbPath));
  const targetInfo = lstatSync(source.targetDbPath);
  if (!targetInfo.isFile() || targetInfo.mode & 0o077 || targetInfo.uid !== process.getuid()) fail();
  const scope = new Map();
  for (const row of source.profiles) {
    if (!safeId(row.profileId) || !safeId(row.sourceProfileRef) ||
        !Array.isArray(row.vacancyIds) || row.vacancyIds.some(id => !safeId(id))) fail();
    scope.set(row.sourceProfileRef, { profileId: row.profileId, vacancies: new Set(row.vacancyIds) });
  }
  const old = new Database(cronDbPath, { readonly: true, fileMustExist: true });
  const target = new Database(source.targetDbPath, { readonly: true, fileMustExist: true });
  let receipt;
  try {
    const jobs = old.prepare(`SELECT id,profile_id,arguments_json,last_status,enabled,
      last_run_at FROM cron_jobs WHERE action='hh_proactive_search'`).all();
    if (jobs.length !== cronManifest.hhCronDefinitions ||
        jobs.some(job => job.enabled !== 0) ||
        jobs.filter(job => job.last_status === 'unknown').length !== 8) fail();
    const executions = old.prepare(`SELECT id,status,scheduled_at,started_at,finished_at,
      result_json,error_json FROM action_executions WHERE cron_id=? ORDER BY created_at,id`);
    const snapshots = target.prepare(`SELECT source_file,searched_at,acceptance_status,payload
      FROM r03_legacy_content_snapshot WHERE migration_id=? AND profile_id=? AND vacancy_id=?`);
    const rows = [];
    for (const job of jobs.filter(item => item.last_status === 'unknown')) {
      let vacancyId;
      try { vacancyId = String(JSON.parse(job.arguments_json).vacancy_id); } catch { fail(); }
      const bound = scope.get(job.profile_id);
      if (!safeId(job.id) || !safeId(vacancyId) || !bound?.vacancies.has(vacancyId)) fail();
      const history = executions.all(job.id);
      const last = history.at(-1);
      if (!last || last.status !== 'unknown' || !last.scheduled_at || !last.finished_at) fail();
      const sourceSnapshots = snapshots.all(source.migrationId, bound.profileId, vacancyId);
      if (sourceSnapshots.some(row => row.acceptance_status !== 'quarantined')) fail();
      rows.push({ legacyJobId: job.id, profileId: bound.profileId, vacancyId,
        lastRunAt: job.last_run_at, lastSlot: last.scheduled_at,
        disposition: 'quarantined_ambiguous',
        reason: 'unknown_dispatch_without_occurrence_bound_accepted_receipt',
        history: history.map(run => ({ executionId: run.id, status: run.status,
          scheduledAt: run.scheduled_at, startedAt: run.started_at, finishedAt: run.finished_at,
          resultSha256: sha(run.result_json), errorSha256: sha(run.error_json) })),
        sourceSnapshots: sourceSnapshots.map(snapshot => ({ sourceFile: snapshot.source_file,
          searchedAt: snapshot.searched_at, payloadSha256: sha(snapshot.payload),
          acceptanceStatus: snapshot.acceptance_status })) });
    }
    rows.sort((a, b) => a.legacyJobId.localeCompare(b.legacyJobId));
    receipt = { version: 'r03-private-unknown-audit-v1', migrationId: source.migrationId,
      archiveSha256: archive.sha256, cronSha256: cron.sha256,
      disposition: 'quarantined_ambiguous', jobs: rows };
  } finally { old.close(); target.close(); }
  const bytes = JSON.stringify(receipt) + '\n';
  try { writeFileSync(outputFile, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (privateBytes(outputFile, 16 * 1024 * 1024).toString('utf8') !== bytes) fail();
  }
  return { status: 'quarantined', unknownDefinitions: receipt.jobs.length,
    quarantinedDefinitions: receipt.jobs.length, resolvedDefinitions: 0,
    linkedExecutions: receipt.jobs.reduce((n, row) => n + row.history.length, 0),
    quarantinedSnapshots: receipt.jobs.reduce((n, row) => n + row.sourceSnapshots.length, 0) };
}

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--import-config' && options.importConfigFile === undefined) options.importConfigFile = argv[++i];
    else if (arg === '--cron-db' && options.cronDbPath === undefined) options.cronDbPath = argv[++i];
    else if (arg === '--cron-manifest' && options.cronManifestPath === undefined) options.cronManifestPath = argv[++i];
    else if (arg === '--output' && options.outputFile === undefined) options.outputFile = argv[++i];
    else fail();
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await auditPrivateLegacyUnknowns(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_unknown_audit', ...result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_unknown_audit', status: 'failed',
      code: 'private_unknown_audit_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
