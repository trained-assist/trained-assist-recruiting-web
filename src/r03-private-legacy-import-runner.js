import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { R03LegacyContentImporter } from './r03-legacy-content-import.js';
import { buildInput, checkedTar, digestPrivateFile, privateBytes, privateDirectory,
  readPrivateJson, relevantSources } from './r03-private-legacy-archive.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sourceRef = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !/[\x00-\x1f/\\]/.test(value) && value !== '.' && value !== '..';
const fail = () => { throw new Error('private_legacy_import_unavailable'); };

function loadConfig(path) {
  const record = readPrivateJson(path, 1024 * 1024);
  if (!object(record) || Object.keys(record).sort().join(',') !==
      'archiveBytes,archivePath,archiveSha256,manifestPath,migrationId,profiles,receiptDirectory,scratchDirectory,targetDbPath,version' ||
      record.version !== 'r03-private-legacy-import-v1' || !safeId(record.migrationId) ||
      !Number.isSafeInteger(record.archiveBytes) || record.archiveBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(record.archiveSha256) ||
      !Array.isArray(record.profiles) || record.profiles.length < 1 || record.profiles.length > 100) fail();
  for (const field of ['archivePath', 'manifestPath', 'targetDbPath']) {
    const p = record[field];
    if (typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p) fail();
  }
  if (dirname(record.archivePath) !== dirname(record.manifestPath)) fail();
  privateDirectory(dirname(record.archivePath));
  privateDirectory(dirname(record.targetDbPath));
  privateDirectory(record.scratchDirectory);
  privateDirectory(record.receiptDirectory);
  try {
    const info = lstatSync(record.targetDbPath);
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) fail();
  } catch (error) { if (error?.code !== 'ENOENT') fail(); }
  const bySource = new Map(), byTarget = new Map();
  for (const row of record.profiles) {
    if (!object(row) || Object.keys(row).sort().join(',') !==
        'expectedCounts,profileId,sourceProfileRef,vacancyIds' ||
        !sourceRef(row.sourceProfileRef) || !safeId(row.profileId) ||
        bySource.has(row.sourceProfileRef) || byTarget.has(row.profileId) ||
        !Array.isArray(row.vacancyIds) || row.vacancyIds.length < 1 || row.vacancyIds.length > 1000 ||
        row.vacancyIds.some(id => !safeId(id)) || new Set(row.vacancyIds).size !== row.vacancyIds.length ||
        !object(row.expectedCounts)) fail();
    bySource.set(row.sourceProfileRef, row);
    byTarget.set(row.profileId, new Set(row.vacancyIds));
  }
  return { ...record, bySource, byTarget,
    bindProfile: source => bySource.get(source)?.profileId ?? null,
    isVacancyOwned: (profileId, vacancyId) => byTarget.get(profileId)?.has(vacancyId) === true };
}

export async function runPrivateLegacyImport({ mode, configFile, execute = false } = {}) {
  if (!['check', 'import'].includes(mode) || mode === 'import' && execute !== true) fail();
  const config = loadConfig(configFile);
  const manifest = readPrivateJson(config.manifestPath, 1024 * 1024);
  if (!object(manifest) || manifest.migrationId !== config.migrationId ||
      !['initial_unfrozen', 'final_frozen'].includes(manifest.kind) ||
      manifest.bytes !== config.archiveBytes || manifest.sha256 !== config.archiveSha256) fail();
  const checksum = await digestPrivateFile(config.archivePath, 1024 * 1024 * 1024);
  if (checksum.bytes !== config.archiveBytes || checksum.sha256 !== config.archiveSha256) fail();
  const paths = checkedTar(config.archivePath);
  if (!paths.some(path => path === 'agent-data/hh/' || path === 'agent-data/hh')) fail();
  const oldUmask = process.umask(0o077);
  let temporary;
  try {
    temporary = mkdtempSync(join(config.scratchDirectory, 'r03-import-'));
    const extracted = spawnSync('tar', ['--no-same-owner', '--no-same-permissions', '-xf',
      config.archivePath, '-C', temporary, 'agent-data/hh'], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1024 * 1024 });
    if (extracted.status !== 0) fail();
    const discovered = relevantSources(temporary);
    if (JSON.stringify(discovered) !== JSON.stringify([...config.bySource.keys()].sort())) fail();
    const inputs = discovered.map(source => buildInput(temporary, config.bySource.get(source), config.migrationId));
    const preflightPath = join(temporary, 'preflight.sqlite');
    const dry = new R03LegacyContentImporter({ filename: preflightPath,
      bindProfile: config.bindProfile, isVacancyOwned: config.isVacancyOwned });
    let plans;
    try { plans = inputs.map(input => dry.plan(input)); } finally { dry.close(); }
    const totals = Object.fromEntries(Object.keys(plans[0].counts).map(key =>
      [key, plans.reduce((sum, plan) => sum + plan.counts[key], 0)]));
    if (mode === 'check') return { mode, status: 'ready', backupKind: manifest.kind,
      profileCount: plans.length, counts: totals };
    const importer = new R03LegacyContentImporter({ filename: config.targetDbPath,
      bindProfile: config.bindProfile, isVacancyOwned: config.isVacancyOwned });
    let receipts;
    try { receipts = importer.db.transaction(() => inputs.map(input => importer.import(input))).immediate(); }
    finally { importer.close(); }
    if (receipts.some(receipt => !['imported', 'replayed'].includes(receipt.kind))) fail();
    const receiptPath = join(config.receiptDirectory, `${config.migrationId}.json`);
    const privateReceipt = { migrationId: config.migrationId, backupKind: manifest.kind,
      archiveBytes: config.archiveBytes, archiveSha256: config.archiveSha256,
      receipts: receipts.map(({ kind, ...stable }) => stable) };
    const serialized = JSON.stringify(privateReceipt) + '\n';
    try { writeFileSync(receiptPath, serialized, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error?.code !== 'EEXIST' || privateBytes(receiptPath, 1024 * 1024).toString('utf8') !== serialized) fail();
    }
    return { mode, status: 'completed', backupKind: manifest.kind,
      profileCount: receipts.length, counts: totals, importedProfiles: receipts.filter(row => row.kind === 'imported').length };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    process.umask(oldUmask);
  }
}

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--mode' && options.mode === undefined) options.mode = argv[++i];
    else if (value === '--config' && options.configFile === undefined) options.configFile = argv[++i];
    else if (value === '--execute' && options.execute === undefined) options.execute = true;
    else fail();
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runPrivateLegacyImport(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_legacy_import', ...result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_legacy_import', status: 'failed',
      code: 'private_legacy_import_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
