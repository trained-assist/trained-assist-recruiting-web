import { spawnSync } from 'node:child_process';
import { lstatSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { checkedTar, digestPrivateFile, privateDirectory, readPrivateJson } from './r03-private-legacy-archive.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value);
const sourceRef = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !/[\x00-\x1f/\\]/.test(value) && value !== '.' && value !== '..';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('private_legacy_binding_unavailable'); };

function archiveJson(archivePath, member, maxBuffer) {
  const result = spawnSync('tar', ['-xOf', archivePath, member],
    { encoding: 'utf8', maxBuffer });
  if (result.status !== 0) fail();
  try { return JSON.parse(result.stdout); } catch { fail(); }
}

// Uses the old agent's canonical cron profile_id plus its own profile workspace
// context. Historical source-only vacancy IDs require an explicit counted
// quarantine decision and are never converted into target ownership.
export async function createPrivateLegacyBinding({ archivePath, manifestPath,
  inventoryFile, cronDbPath, cronManifestPath, targetDbPath, scratchDirectory,
  receiptDirectory, outputFile, expectedExcludedVacancies } = {}) {
  for (const path of [archivePath, manifestPath, inventoryFile, cronDbPath,
    cronManifestPath, targetDbPath, outputFile])
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail();
  if (!Number.isSafeInteger(expectedExcludedVacancies) || expectedExcludedVacancies < 0 ||
      expectedExcludedVacancies > 100) fail();
  for (const path of [archivePath, manifestPath, inventoryFile, cronDbPath,
    cronManifestPath, targetDbPath, outputFile]) privateDirectory(dirname(path));
  privateDirectory(scratchDirectory);
  privateDirectory(receiptDirectory);
  try {
    const info = lstatSync(targetDbPath);
    if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid()) fail();
  } catch (error) { if (error?.code !== 'ENOENT') fail(); }
  const manifest = readPrivateJson(manifestPath, 1024 * 1024);
  const inventory = readPrivateJson(inventoryFile, 1024 * 1024);
  const cronManifest = readPrivateJson(cronManifestPath, 1024 * 1024);
  if (manifest?.kind !== 'final_frozen' || !safeId(manifest.migrationId) ||
      !Number.isSafeInteger(manifest.bytes) || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      inventory?.migrationId !== manifest.migrationId || inventory.backupKind !== manifest.kind ||
      inventory.archiveBytes !== manifest.bytes || inventory.archiveSha256 !== manifest.sha256 ||
      !Array.isArray(inventory.profiles) || inventory.profiles.length < 1 ||
      cronManifest?.kind !== 'cron_frozen' || !Number.isSafeInteger(cronManifest.bytes) ||
      !/^[a-f0-9]{64}$/.test(cronManifest.sha256) ||
      cronManifest.hhCronDefinitions !== 11 || cronManifest.enabled !== 0 || cronManifest.unknown !== 8) fail();
  const [archive, cron] = await Promise.all([
    digestPrivateFile(archivePath, 1024 * 1024 * 1024),
    digestPrivateFile(cronDbPath, 1024 * 1024 * 1024)
  ]);
  if (archive.bytes !== manifest.bytes || archive.sha256 !== manifest.sha256 ||
      cron.bytes !== cronManifest.bytes || cron.sha256 !== cronManifest.sha256) fail();
  const members = new Set(checkedTar(archivePath));
  const db = new Database(cronDbPath, { readonly: true, fileMustExist: true });
  let jobs;
  try { jobs = db.prepare(`SELECT profile_id, arguments_json, enabled, last_status
    FROM cron_jobs WHERE action='hh_proactive_search'`).all(); }
  finally { db.close(); }
  if (jobs.length !== 11 || jobs.some(job => job.enabled !== 0) ||
      jobs.filter(job => job.last_status === 'unknown').length !== 8) fail();
  const cronByProfile = new Map();
  for (const job of jobs) {
    let vacancyId;
    try { vacancyId = String(JSON.parse(job.arguments_json).vacancy_id); } catch { fail(); }
    if (!safeId(job.profile_id) || !safeId(vacancyId)) fail();
    if (!cronByProfile.has(job.profile_id)) cronByProfile.set(job.profile_id, new Set());
    cronByProfile.get(job.profile_id).add(vacancyId);
  }
  if (cronByProfile.size !== inventory.profiles.length) fail();
  const profiles = [];
  let exclusions = 0;
  for (const row of inventory.profiles) {
    if (!object(row) || !sourceRef(row.sourceProfileRef) || !cronByProfile.has(row.sourceProfileRef) ||
        row.targetProfileId !== null || !Array.isArray(row.observedVacancyIds) ||
        row.observedVacancyIds.some(id => !safeId(id)) || !object(row.expectedCounts)) fail();
    const profileId = row.sourceProfileRef; // Old agent cron profile_id IS the username.
    const contextMember = `users/${profileId}/contexts/hh/active_vacancies.json`;
    const candidateMember = `agent-data/hh/${profileId}/proactive/all-candidates.json`;
    if (!members.has(contextMember) || !members.has(candidateMember)) fail();
    const context = archiveJson(archivePath, contextMember, 1024 * 1024);
    let value = context?.value;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { fail(); } }
    if (!Array.isArray(value)) fail();
    const active = new Set(value.map(vacancy => String(vacancy?.id ?? '')));
    if ([...active].some(id => !safeId(id))) fail();
    const observed = new Set(row.observedVacancyIds);
    const vacancyIds = [...observed].filter(id => active.has(id)).sort();
    const quarantinedSourceVacancyIds = [...observed].filter(id => !active.has(id)).sort();
    if (vacancyIds.length < 1 ||
        [...cronByProfile.get(profileId)].some(id => !active.has(id) || !observed.has(id))) fail();
    const candidates = archiveJson(archivePath, candidateMember, 32 * 1024 * 1024);
    if (!object(candidates) || Object.values(candidates).some(candidate =>
      candidate?.vacancy_ids?.some(id => quarantinedSourceVacancyIds.includes(String(id))))) fail();
    for (const id of quarantinedSourceVacancyIds)
      if (members.has(`users/${profileId}/contexts/hh/ats_config:${id}.json`)) fail();
    exclusions += quarantinedSourceVacancyIds.length;
    profiles.push({ sourceProfileRef: row.sourceProfileRef, profileId, vacancyIds,
      quarantinedSourceVacancyIds, expectedCounts: row.expectedCounts });
  }
  if (exclusions !== expectedExcludedVacancies) fail();
  const config = { version: 'r03-private-legacy-import-v1', migrationId: manifest.migrationId,
    archivePath, archiveBytes: manifest.bytes, archiveSha256: manifest.sha256,
    manifestPath, targetDbPath, scratchDirectory, receiptDirectory, profiles };
  writeFileSync(outputFile, JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'bound', profileCount: profiles.length, cronDefinitions: jobs.length,
    ownedVacancyScopes: profiles.reduce((sum, row) => sum + row.vacancyIds.length, 0),
    quarantinedSourceVacancyScopes: exclusions };
}

function args(argv) {
  const fields = { '--archive': 'archivePath', '--manifest': 'manifestPath',
    '--inventory': 'inventoryFile', '--cron-db': 'cronDbPath',
    '--cron-manifest': 'cronManifestPath', '--target-db': 'targetDbPath',
    '--scratch': 'scratchDirectory', '--receipts': 'receiptDirectory',
    '--output': 'outputFile', '--expected-exclusions': 'expectedExcludedVacancies' };
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = fields[argv[i]];
    if (!key || options[key] !== undefined) fail();
    options[key] = argv[++i];
  }
  options.expectedExcludedVacancies = Number(options.expectedExcludedVacancies);
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await createPrivateLegacyBinding(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_legacy_binding', ...result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_legacy_binding', status: 'failed',
      code: 'private_legacy_binding_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
