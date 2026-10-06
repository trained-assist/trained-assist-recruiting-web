import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInput, checkedTar, digestPrivateFile, privateDirectory,
  readPrivateJson, relevantSources } from './r03-private-legacy-archive.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value);
const sourceRef = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !/[\x00-\x1f/\\]/.test(value) && value !== '.' && value !== '..';
const fail = () => { throw new Error('private_legacy_inventory_unavailable'); };

function countProfile(input) {
  const candidates = new Map(Object.entries(input.allCandidates).map(([id, row]) => [id, row.vacancy_ids ?? []]));
  const scope = (id, vacancy) => !candidates.has(id) ? 'missing' :
    candidates.get(id).length === 0 || candidates.get(id).includes(vacancy) ? 'matched' : 'mismatch';
  const seen = Object.entries(input.seenIds).flatMap(([vacancyId, bucket]) =>
    Object.keys(bucket).map(id => ({ vacancyId, id,
      status: safeId(vacancyId) ? scope(id, vacancyId) : 'unsafe_vacancy' })));
  const snapshots = input.snapshots.map(row => {
    const vacancy = String(row.payload.vacancy_id ?? '');
    const unboundVacancy = !safeId(vacancy);
    const ids = row.payload.candidates.map(candidate => candidate.id);
    return { vacancy, unboundVacancy, filenameMismatch: !row.sourceFile.endsWith(`-${vacancy}.json`),
      missing: ids.filter(id => !candidates.has(id)).length,
      mismatch: unboundVacancy ? 0 : ids.filter(id => scope(id, vacancy) === 'mismatch').length };
  });
  const comments = Object.entries(input.comments).flatMap(([vacancyId, bucket]) =>
    Object.keys(bucket).map(id => ({ status: scope(id, vacancyId) })));
  const globalComments = Object.keys(input.globalComments ?? {});
  const unboundSeen = seen.filter(row => row.status === 'missing').length;
  const unboundSnapshotMembers = snapshots.reduce((sum, row) => sum + row.missing, 0);
  const unboundComments = comments.filter(row => row.status === 'missing').length +
    globalComments.filter(id => !candidates.has(id)).length;
  return { allCandidates: candidates.size, seenIds: seen.length, snapshots: snapshots.length,
    comments: comments.length + globalComments.length, globalComments: globalComments.length,
    wildcardQuarantined: [...candidates.values()].filter(ids => ids.length === 0).length,
    quarantinedSnapshots: snapshots.length, unboundSeen,
    mismatchedSeen: seen.filter(row => row.status === 'mismatch').length,
    unsafeSeenVacancyBuckets: Object.keys(input.seenIds).filter(id => !safeId(id)).length,
    unsafeSeenRows: seen.filter(row => row.status === 'unsafe_vacancy').length,
    unboundSnapshotMembers, mismatchedSnapshotMembers: snapshots.reduce((sum, row) => sum + row.mismatch, 0),
    snapshotFilenameMismatches: snapshots.filter(row => row.filenameMismatch).length,
    unboundVacancySnapshots: snapshots.filter(row => row.unboundVacancy).length,
    unboundComments, mismatchedComments: comments.filter(row => row.status === 'mismatch').length,
    unboundReferences: unboundSeen + unboundSnapshotMembers + unboundComments };
}

function observedVacancies(input) {
  const ids = new Set();
  for (const candidate of Object.values(input.allCandidates))
    for (const id of candidate.vacancy_ids ?? []) if (safeId(id)) ids.add(id);
  for (const id of Object.keys(input.seenIds)) if (safeId(id)) ids.add(id);
  for (const row of input.snapshots) if (safeId(String(row.payload.vacancy_id ?? '')))
    ids.add(String(row.payload.vacancy_id));
  for (const id of Object.keys(input.comments)) if (safeId(id)) ids.add(id);
  return [...ids].sort();
}

// Inventory is source-derived evidence only. It leaves the target profile ID
// unresolved for the operator/agent-owned identity mapping to supply.
export async function createPrivateLegacyInventory({ archivePath, manifestPath,
  scratchDirectory, inventoryFile } = {}) {
  for (const p of [archivePath, manifestPath, inventoryFile])
    if (typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p) fail();
  if (dirname(archivePath) !== dirname(manifestPath)) fail();
  privateDirectory(dirname(archivePath));
  privateDirectory(scratchDirectory);
  privateDirectory(dirname(inventoryFile));
  const manifest = readPrivateJson(manifestPath, 1024 * 1024);
  if (!safeId(manifest?.migrationId) || !['initial_unfrozen', 'final_frozen'].includes(manifest.kind) ||
      !Number.isSafeInteger(manifest.bytes) || !/^[a-f0-9]{64}$/.test(manifest.sha256)) fail();
  const actual = await digestPrivateFile(archivePath, 1024 * 1024 * 1024);
  if (actual.bytes !== manifest.bytes || actual.sha256 !== manifest.sha256) fail();
  const paths = checkedTar(archivePath);
  if (!paths.some(path => path === 'agent-data/hh/' || path === 'agent-data/hh')) fail();
  const oldUmask = process.umask(0o077);
  let temporary;
  try {
    temporary = mkdtempSync(join(scratchDirectory, 'r03-inventory-'));
    const extracted = spawnSync('tar', ['--no-same-owner', '--no-same-permissions', '-xf',
      archivePath, '-C', temporary, 'agent-data/hh'], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1024 * 1024 });
    if (extracted.status !== 0) fail();
    const profiles = relevantSources(temporary).map(sourceProfileRef => {
      if (!sourceRef(sourceProfileRef)) fail();
      const input = buildInput(temporary, { sourceProfileRef, expectedCounts: null }, manifest.migrationId);
      return { sourceProfileRef, targetProfileId: null,
        observedVacancyIds: observedVacancies(input), expectedCounts: countProfile(input) };
    });
    const totals = Object.fromEntries(Object.keys(profiles[0]?.expectedCounts ?? {}).map(key =>
      [key, profiles.reduce((sum, row) => sum + row.expectedCounts[key], 0)]));
    const privateInventory = { version: 'r03-private-legacy-inventory-v1',
      migrationId: manifest.migrationId, backupKind: manifest.kind,
      archiveBytes: manifest.bytes, archiveSha256: manifest.sha256, profiles, totals };
    const serialized = JSON.stringify(privateInventory) + '\n';
    try { writeFileSync(inventoryFile, serialized, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error?.code !== 'EEXIST' || readFileSync(inventoryFile, 'utf8') !== serialized) fail();
    }
    return { status: 'inventoried', backupKind: manifest.kind, profileCount: profiles.length, totals };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    process.umask(oldUmask);
  }
}

function args(argv) {
  const fields = { '--archive': 'archivePath', '--manifest': 'manifestPath',
    '--scratch': 'scratchDirectory', '--inventory-file': 'inventoryFile' };
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = fields[argv[i]];
    if (!key || options[key] !== undefined) fail();
    options[key] = argv[++i];
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await createPrivateLegacyInventory(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_legacy_inventory', ...result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_legacy_inventory', status: 'failed',
      code: 'private_legacy_inventory_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
