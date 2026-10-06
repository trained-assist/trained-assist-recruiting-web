import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateBytes, privateDirectory, readPrivateJson } from './r03-private-legacy-archive.js';
import { planLegacySeenPromotion, promoteLegacySeen } from './r03-legacy-seen-promotion.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('private_legacy_seen_promotion_unavailable'); };

function samePrivateFile(path, value) {
  const serialized = JSON.stringify(value) + '\n';
  try { writeFileSync(path, serialized, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error?.code !== 'EEXIST' ||
        privateBytes(path, 1024 * 1024).toString('utf8') !== serialized) fail();
  }
}

export function runPrivateLegacySeenPromotion({ mode, configFile, planFile,
  execute = false } = {}) {
  if (!['plan', 'promote'].includes(mode) || mode === 'promote' && execute !== true ||
      typeof planFile !== 'string' || !isAbsolute(planFile) || resolve(planFile) !== planFile) fail();
  privateDirectory(dirname(planFile));
  const config = readPrivateJson(configFile, 1024 * 1024);
  if (!object(config) || config.version !== 'r03-private-legacy-import-v1' ||
      !safeId(config.migrationId) || typeof config.targetDbPath !== 'string' ||
      typeof config.receiptDirectory !== 'string' ||
      !Array.isArray(config.profiles) || config.profiles.length < 1) fail();
  privateDirectory(config.receiptDirectory);
  const receiptFile = join(config.receiptDirectory, `${config.migrationId}.json`);
  const sourceReceipt = readPrivateJson(receiptFile, 1024 * 1024);
  if (sourceReceipt.migrationId !== config.migrationId ||
      sourceReceipt.backupKind !== 'final_frozen' ||
      sourceReceipt.archiveSha256 !== config.archiveSha256 ||
      sourceReceipt.archiveBytes !== config.archiveBytes) fail();
  const owned = new Map();
  for (const row of config.profiles) {
    if (!object(row) || !safeId(row.profileId) || owned.has(row.profileId) ||
        !Array.isArray(row.vacancyIds) || row.vacancyIds.some(id => !safeId(id))) fail();
    owned.set(row.profileId, new Set(row.vacancyIds));
  }
  if (owned.size !== sourceReceipt.receipts?.length ||
      sourceReceipt.receipts.some(row => !owned.has(row.profileId))) fail();
  const isVacancyOwned = (profileId, vacancyId) => owned.get(profileId)?.has(vacancyId) === true;
  const current = planLegacySeenPromotion({ filename: config.targetDbPath,
    sourceReceipt, isVacancyOwned });
  const privatePlan = { version: 'r03-legacy-seen-promotion-plan-v1', ...current };
  if (mode === 'plan') {
    samePrivateFile(planFile, privatePlan);
    return { status: 'planned', counts: current.counts };
  }
  const approved = readPrivateJson(planFile, 1024 * 1024);
  if (JSON.stringify(approved) !== JSON.stringify(privatePlan)) fail();
  const result = promoteLegacySeen({ filename: config.targetDbPath, sourceReceipt,
    isVacancyOwned, expectedCounts: approved.counts,
    expectedSelectionSha256: approved.selectionSha256 });
  const stable = { version: 'r03-legacy-seen-promotion-receipt-v1',
    migrationId: current.migrationId, archiveSha256: current.archiveSha256,
    sourceReceiptSha256: current.sourceReceiptSha256,
    selectionSha256: current.selectionSha256, counts: current.counts,
    inserted: result.inserted, advanced: result.advanced };
  samePrivateFile(join(config.receiptDirectory,
    `${config.migrationId}-seen-promotion.json`), stable);
  return { status: 'completed', kind: result.kind,
    counts: current.counts, inserted: result.inserted, advanced: result.advanced };
}

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--mode' && options.mode === undefined) options.mode = argv[++i];
    else if (key === '--config' && options.configFile === undefined) options.configFile = argv[++i];
    else if (key === '--plan-file' && options.planFile === undefined) options.planFile = argv[++i];
    else if (key === '--execute' && options.execute === undefined) options.execute = true;
    else fail();
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = runPrivateLegacySeenPromotion(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_legacy_seen_promotion', ...result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_legacy_seen_promotion',
      status: 'failed', code: 'private_legacy_seen_promotion_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
