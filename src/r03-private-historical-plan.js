import { spawnSync } from 'node:child_process';
import { lstatSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { checkedTar, digestPrivateFile, privateBytes, privateDirectory,
  readPrivateJson } from './r03-private-legacy-archive.js';
import { loadPrivateHostConfig } from './r03-private-host-config.js';
import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';
import { classifyLegacyHistoricalSnapshot, planLegacyHistoricalFeed } from './r03-legacy-historical-plan.js';

const fail = () => { throw new Error('private_historical_plan_unavailable'); };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sourceRef = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !/[\x00-\x1f/\\]/.test(value) && value !== '.' && value !== '..';
const pathCheck = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;

export async function planPrivateHistoricalFeed({ importConfigFile, hostConfigFile, outputFile } = {}) {
  if (![importConfigFile, hostConfigFile, outputFile].every(pathCheck)) fail();
  privateDirectory(dirname(outputFile));
  const source = readPrivateJson(importConfigFile, 1024 * 1024);
  const manifest = readPrivateJson(source?.manifestPath, 1024 * 1024);
  if (source?.version !== 'r03-private-legacy-import-v1' || !safeId(source.migrationId) ||
    manifest?.kind !== 'final_frozen' || manifest.migrationId !== source.migrationId ||
    manifest.sha256 !== source.archiveSha256 || manifest.bytes !== source.archiveBytes ||
    !Array.isArray(source.profiles)) fail();
  const digest = await digestPrivateFile(source.archivePath, 1024 * 1024 * 1024);
  if (digest.sha256 !== source.archiveSha256 || digest.bytes !== source.archiveBytes) fail();
  const members = new Set(checkedTar(source.archivePath));
  const host = loadPrivateHostConfig(hostConfigFile);
  if (host.dbPath !== source.targetDbPath) fail();
  privateDirectory(dirname(source.targetDbPath));
  const info = lstatSync(source.targetDbPath);
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) fail();
  const byProfile = new Map();
  for (const row of source.profiles) {
    if (!safeId(row.profileId) || !sourceRef(row.sourceProfileRef) || byProfile.has(row.profileId) ||
      !Array.isArray(row.vacancyIds) || row.vacancyIds.some(id =>
        !safeId(id) || !host.isVacancyOwned(row.profileId, id)) ||
      JSON.stringify([...row.vacancyIds].sort()) !==
        JSON.stringify(host.vacancyIdsForProfile(row.profileId).sort())) fail();
    byProfile.set(row.profileId, row);
  }
  const db = new Database(source.targetDbPath, { readonly: true, fileMustExist: true });
  const loadPlan = createPrivateBaseSearchPlan({ resolveProfileBinding: host.resolveProfileBinding,
    isVacancyOwned: host.isVacancyOwned });
  let receipt;
  try {
    db.pragma('query_only = ON');
    const imports = db.prepare(`SELECT profile_id,source_receipts,counts FROM r03_legacy_content_import
      WHERE migration_id=? ORDER BY profile_id`).all(source.migrationId);
    if (imports.length !== byProfile.size) fail();
    const sourceReceipts = new Map();
    let expectedSnapshots = 0;
    for (const row of imports) {
      if (!byProfile.has(row.profile_id)) fail();
      const entries = JSON.parse(row.source_receipts);
      const counts = JSON.parse(row.counts);
      if (!Array.isArray(entries) || !Number.isSafeInteger(counts.snapshots)) fail();
      expectedSnapshots += counts.snapshots;
      for (const entry of entries) {
        if (typeof entry.file !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) fail();
        const key = `${row.profile_id}\0${entry.file}`;
        if (sourceReceipts.has(key)) fail();
        sourceReceipts.set(key, entry);
      }
    }
    const candidates = new Map();
    for (const row of db.prepare(`SELECT profile_id,resume_id,vacancy_ids
      FROM r03_legacy_content_candidate WHERE migration_id=?`).iterate(source.migrationId)) {
      const key = `${row.profile_id}\0${row.resume_id}`;
      if (candidates.has(key)) fail();
      candidates.set(key, JSON.parse(row.vacancy_ids));
    }
    const seen = new Map();
    for (const row of db.prepare(`SELECT profile_id,vacancy_id,resume_id,first_seen_at
      FROM real_hh_seen`).iterate())
      seen.set(`${row.profile_id}\0${row.vacancy_id}\0${row.resume_id}`, row.first_seen_at);
    const snapshots = db.prepare(`SELECT * FROM r03_legacy_content_snapshot
      WHERE migration_id=? ORDER BY profile_id,source_file`).all(source.migrationId);
    if (snapshots.length !== expectedSnapshots) fail();
    const currentPlans = new Map();
    for (const profile of source.profiles) for (const vacancyId of profile.vacancyIds) {
      try { currentPlans.set(`${profile.profileId}\0${vacancyId}`,
        await loadPlan(profile.profileId, vacancyId, { allowGeneration: false })); }
      catch { currentPlans.set(`${profile.profileId}\0${vacancyId}`, null); }
    }
    const rows = [];
    for (const row of snapshots) {
      const sourceProfileRef = byProfile.get(row.profile_id)?.sourceProfileRef;
      if (!sourceProfileRef || typeof row.source_file !== 'string' ||
        !/^search-results-[A-Za-z0-9_-]+\.json$/.test(row.source_file)) fail();
      const member = `agent-data/hh/${sourceProfileRef}/proactive/${row.source_file}`;
      if (!members.has(member)) fail();
      const extracted = spawnSync('tar', ['-xOf', source.archivePath, member],
        { maxBuffer: 32 * 1024 * 1024 });
      if (extracted.status !== 0 || extracted.stdout.length > 32 * 1024 * 1024) fail();
      const localCandidates = new Map();
      const localSeen = new Map();
      let ids;
      try { ids = JSON.parse(row.candidate_ids); } catch { ids = []; }
      if (Array.isArray(ids)) for (const id of ids) {
        localCandidates.set(id, candidates.get(`${row.profile_id}\0${id}`));
        localSeen.set(id, seen.get(`${row.profile_id}\0${row.vacancy_id}\0${id}`));
      }
      rows.push(classifyLegacyHistoricalSnapshot({ row, rawBytes: extracted.stdout,
        sourceReceipt: sourceReceipts.get(`${row.profile_id}\0${row.source_file}`),
        isVacancyOwned: host.isVacancyOwned, candidates: localCandidates, seen: localSeen,
        currentPlan: currentPlans.get(`${row.profile_id}\0${row.vacancy_id}`) }));
    }
    const plan = planLegacyHistoricalFeed(rows);
    receipt = { version: 'r03-private-historical-plan-v1', migrationId: source.migrationId,
      archiveSha256: digest.sha256, status: 'historical_only', summary: {
        total: plan.total, historicalReadable: plan.historicalReadable, blocked: plan.blocked,
        reasons: plan.reasons, currentReady: plan.currentReady,
        currentCriteriaMatch: plan.currentCriteriaMatch,
        recommendedLatest: plan.recommendedLatest.length, accepted: 0 },
      rows, recommendedLatest: plan.recommendedLatest.map(row => ({ profileId: row.profileId,
        vacancyId: row.vacancyId, sourceFile: row.sourceFile, searchedAt: row.searchedAt })) };
  } finally { db.close(); }
  const bytes = JSON.stringify(receipt) + '\n';
  try { writeFileSync(outputFile, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error?.code !== 'EEXIST' || privateBytes(outputFile, 16 * 1024 * 1024).toString('utf8') !== bytes) fail();
  }
  return receipt.summary;
}

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--import-config' && options.importConfigFile === undefined) options.importConfigFile = argv[++i];
    else if (arg === '--host-config' && options.hostConfigFile === undefined) options.hostConfigFile = argv[++i];
    else if (arg === '--output' && options.outputFile === undefined) options.outputFile = argv[++i];
    else fail();
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.stdout.write(JSON.stringify({ event: 'r03.private_historical_plan',
    ...await planPrivateHistoricalFeed(args(process.argv.slice(2))) }) + '\n'); }
  catch { process.stdout.write(JSON.stringify({ event: 'r03.private_historical_plan',
    status: 'failed', code: 'private_historical_plan_unavailable' }) + '\n'); process.exitCode = 78; }
}
