import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { checkedTar, privateBytes, readPrivateJson } from './r03-private-legacy-archive.js';
import { classifyLegacyHistoricalSnapshot } from './r03-legacy-historical-plan.js';
import { createR03HistoricalRead } from './r03-historical-read.js';

const fail = () => { throw new Error('private_historical_read_unavailable'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sourceRef = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !/[\x00-\x1f/\\]/.test(value) && value !== '.' && value !== '..';

export function loadPrivateHistoricalRead({ importConfigFile, receiptFile,
  receiptSha256, hostConfig }) {
  if (!/^[a-f0-9]{64}$/.test(receiptSha256) ||
      typeof hostConfig?.isVacancyOwned !== 'function' || typeof hostConfig.dbPath !== 'string') fail();
  const receiptBytes = privateBytes(receiptFile, 16 * 1024 * 1024);
  if (sha(receiptBytes) !== receiptSha256) fail();
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const source = readPrivateJson(importConfigFile, 1024 * 1024);
  const manifest = readPrivateJson(source.manifestPath, 1024 * 1024);
  if (receipt?.version !== 'r03-private-historical-plan-v1' ||
      receipt.status !== 'historical_only' || receipt.summary?.accepted !== 0 ||
      !Array.isArray(receipt.rows) || !Array.isArray(receipt.recommendedLatest) ||
      receipt.summary.total !== receipt.rows.length ||
      receipt.summary.recommendedLatest !== receipt.recommendedLatest.length ||
      source?.version !== 'r03-private-legacy-import-v1' ||
      receipt.migrationId !== source.migrationId ||
      receipt.archiveSha256 !== source.archiveSha256 ||
      manifest?.kind !== 'final_frozen' || manifest.migrationId !== source.migrationId ||
      manifest.sha256 !== source.archiveSha256 || manifest.bytes !== source.archiveBytes ||
      hostConfig.dbPath !== source.targetDbPath || !Array.isArray(source.profiles)) fail();
  const archiveMembers = new Set(checkedTar(source.archivePath));
  const profiles = new Map();
  for (const row of source.profiles) {
    if (!safeId(row.profileId) || !sourceRef(row.sourceProfileRef) || profiles.has(row.profileId)) fail();
    profiles.set(row.profileId, row);
  }
  const receiptRows = new Map();
  for (const row of receipt.rows) {
    const key = `${row.profileId}\0${row.sourceFile}`;
    if (!safeId(row.profileId) || typeof row.sourceFile !== 'string' || receiptRows.has(key) ||
        row.accepted !== false || !Array.isArray(row.acceptanceBlockers) ||
        !isDeepStrictEqual(row.acceptanceBlockers, ['missing_occurrence_bound_receipt',
          'missing_criteria_revision', 'missing_source_revision'])) fail();
    receiptRows.set(key, row);
  }
  const db = new Database(source.targetDbPath, { readonly: true, fileMustExist: true });
  const selected = new Map();
  try {
    db.pragma('query_only = ON');
    const imported = db.prepare(`SELECT source_receipts FROM r03_legacy_content_import
      WHERE migration_id=? AND profile_id=?`);
    const snapshot = db.prepare(`SELECT * FROM r03_legacy_content_snapshot
      WHERE migration_id=? AND profile_id=? AND source_file=?`);
    const candidate = db.prepare(`SELECT vacancy_ids FROM r03_legacy_content_candidate
      WHERE migration_id=? AND profile_id=? AND resume_id=?`);
    const seen = db.prepare(`SELECT first_seen_at FROM real_hh_seen
      WHERE profile_id=? AND vacancy_id=? AND resume_id=?`);
    for (const recommendation of receipt.recommendedLatest) {
      const { profileId, vacancyId, sourceFile } = recommendation;
      const key = `${profileId}\0${vacancyId}`;
      const proof = receiptRows.get(`${profileId}\0${sourceFile}`);
      const profile = profiles.get(profileId);
      if (!safeId(profileId) || !safeId(vacancyId) ||
          !/^search-results-[A-Za-z0-9_-]+\.json$/.test(sourceFile) ||
          selected.has(key) || !Array.isArray(profile?.vacancyIds) ||
          !profile.vacancyIds.includes(vacancyId) ||
          !hostConfig.isVacancyOwned(profileId, vacancyId) ||
          !proof || !proof.historicalReadable || !proof.currentReady ||
          !proof.currentCriteriaMatch || proof.vacancyId !== vacancyId ||
          proof.searchedAt !== recommendation.searchedAt ||
          !Array.isArray(proof.reasons) || proof.reasons.length !== 0) fail();
      const record = snapshot.get(source.migrationId, profileId, sourceFile);
      const importRow = imported.get(source.migrationId, profileId);
      if (!record || !importRow) fail();
      const sourceReceipt = JSON.parse(importRow.source_receipts).find(item => item.file === sourceFile);
      const member = `agent-data/hh/${profile.sourceProfileRef}/proactive/${sourceFile}`;
      if (!sourceReceipt || !archiveMembers.has(member)) fail();
      const extracted = spawnSync('tar', ['-xOf', source.archivePath, member],
        { maxBuffer: 32 * 1024 * 1024 });
      if (extracted.status !== 0 || extracted.stdout.length > 32 * 1024 * 1024) fail();
      const ids = JSON.parse(record.candidate_ids);
      if (!Array.isArray(ids)) fail();
      const members = new Map(), viewed = new Map();
      for (const id of ids) {
        const candidateRow = candidate.get(source.migrationId, profileId, id);
        members.set(id, candidateRow ? JSON.parse(candidateRow.vacancy_ids) : null);
        viewed.set(id, seen.get(profileId, vacancyId, id)?.first_seen_at);
      }
      const classification = classifyLegacyHistoricalSnapshot({ row: record,
        rawBytes: extracted.stdout, sourceReceipt, isVacancyOwned: hostConfig.isVacancyOwned,
        candidates: members, seen: viewed });
      if (!classification.historicalReadable || classification.candidateCount !== proof.candidateCount ||
          classification.historicalCriteriaFingerprint !== proof.historicalCriteriaFingerprint ||
          classification.historicalQueryFingerprint !== proof.historicalQueryFingerprint ||
          !isDeepStrictEqual(classification.reasons, proof.reasons)) fail();
      const payload = JSON.parse(record.payload);
      selected.set(key, { searchedAt: record.searched_at, candidates: payload.candidates,
        historicalRevision: sha(JSON.stringify([receiptSha256, profileId, vacancyId,
          sourceFile, sourceReceipt.sha256])).slice(0, 24) });
    }
  } finally { db.close(); }
  return createR03HistoricalRead({ selected, isVacancyOwned: hostConfig.isVacancyOwned });
}
