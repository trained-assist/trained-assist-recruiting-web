import { createHash } from 'node:crypto';
import { lstatSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value);
const hhResumeId = value => typeof value === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value);
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('legacy_seen_promotion_unavailable'); };

function checkedDb(filename, readonly) {
  if (typeof filename !== 'string' || statSync(dirname(filename)).mode & 0o077) fail();
  const info = lstatSync(filename);
  if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid()) fail();
  return new Database(filename, { readonly, fileMustExist: true, timeout: 5000 });
}

function verifiedReceipt(db, receipt) {
  if (!object(receipt) || !safeId(receipt.migrationId) ||
      receipt.backupKind !== 'final_frozen' || !Number.isSafeInteger(receipt.archiveBytes) ||
      receipt.archiveBytes < 1 || !/^[a-f0-9]{64}$/.test(receipt.archiveSha256) ||
      !Array.isArray(receipt.receipts) || receipt.receipts.length < 1 ||
      receipt.receipts.length > 100) fail();
  const imported = db.prepare(`SELECT profile_id, source_digest, counts, source_receipts, quarantine
    FROM r03_legacy_content_import WHERE migration_id=? ORDER BY profile_id`).all(receipt.migrationId);
  if (imported.length !== receipt.receipts.length) fail();
  const byProfile = new Map();
  for (const row of receipt.receipts) {
    if (!object(row) || !safeId(row.profileId) || row.migrationId !== receipt.migrationId ||
        !/^[a-f0-9]{64}$/.test(row.sourceDigest) || !object(row.counts) ||
        !Array.isArray(row.sourceReceipts) || !object(row.quarantine) ||
        !Array.isArray(row.quarantine.unownedVacancyIds) || byProfile.has(row.profileId) ||
        !row.sourceReceipts.some(file => file.file === 'seen-ids.json' &&
          Number.isSafeInteger(file.bytes) && file.bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256))) fail();
    byProfile.set(row.profileId, row);
  }
  for (const row of imported) {
    const fromReceipt = byProfile.get(row.profile_id);
    if (!fromReceipt || row.source_digest !== fromReceipt.sourceDigest ||
        !isDeepStrictEqual(JSON.parse(row.counts), fromReceipt.counts) ||
        !isDeepStrictEqual(JSON.parse(row.source_receipts), fromReceipt.sourceReceipts) ||
        !isDeepStrictEqual(JSON.parse(row.quarantine), fromReceipt.quarantine)) fail();
  }
  return imported.map(row => ({ profileId: row.profile_id,
    quarantinedVacancies: new Set(byProfile.get(row.profile_id).quarantine.unownedVacancyIds) }));
}

function calculate(db, receipt, isVacancyOwned) {
  const profiles = verifiedReceipt(db, receipt);
  const candidates = db.prepare(`SELECT resume_id, vacancy_ids FROM r03_legacy_content_candidate
    WHERE migration_id=? AND profile_id=? ORDER BY resume_id`);
  const seen = db.prepare(`SELECT vacancy_id, resume_id, first_seen_at, unbound_reference,
    vacancy_mismatch, unsafe_vacancy, unowned_vacancy FROM r03_legacy_content_seen
    WHERE migration_id=? AND profile_id=? ORDER BY vacancy_id, resume_id`);
  const counts = { sourceRows: 0, eligible: 0, unsafeVacancy: 0, unownedVacancy: 0, dangling: 0,
    wrongVacancy: 0, wildcard: 0, invalidResumeId: 0, invalidDate: 0 };
  const evidence = [], eligible = [];
  for (const { profileId, quarantinedVacancies } of profiles) {
    const byId = new Map(candidates.all(receipt.migrationId, profileId).map(row => {
      const ids = JSON.parse(row.vacancy_ids);
      if (!Array.isArray(ids)) fail();
      return [row.resume_id, ids];
    }));
    for (const row of seen.all(receipt.migrationId, profileId)) {
      counts.sourceRows++;
      const ids = byId.get(row.resume_id);
      let reason;
      if (row.unsafe_vacancy || !safeId(row.vacancy_id)) reason = 'unsafeVacancy';
      else if (row.unowned_vacancy) {
        if (!quarantinedVacancies.has(row.vacancy_id) ||
            isVacancyOwned(profileId, row.vacancy_id)) fail();
        reason = 'unownedVacancy';
      } else if (!isVacancyOwned(profileId, row.vacancy_id) ||
          quarantinedVacancies.has(row.vacancy_id)) fail();
      else if (row.unbound_reference || !ids) reason = 'dangling';
      else if (row.vacancy_mismatch || ids.length > 0 && !ids.includes(row.vacancy_id)) reason = 'wrongVacancy';
      else if (ids.length === 0) reason = 'wildcard';
      else if (!hhResumeId(row.resume_id)) reason = 'invalidResumeId';
      else if (!dateOnly(row.first_seen_at)) reason = 'invalidDate';
      else reason = 'eligible';
      counts[reason]++;
      const record = [profileId, row.vacancy_id, row.resume_id, row.first_seen_at,
        row.unbound_reference, row.vacancy_mismatch, row.unsafe_vacancy,
        row.unowned_vacancy, ids ?? null, reason];
      evidence.push(record);
      if (reason === 'eligible') eligible.push({ profileId, vacancyId: row.vacancy_id,
        resumeId: row.resume_id, firstSeenAt: row.first_seen_at });
    }
  }
  return { migrationId: receipt.migrationId, archiveSha256: receipt.archiveSha256,
    sourceReceiptSha256: sha(receipt), selectionSha256: sha(evidence), counts, eligible };
}

export function planLegacySeenPromotion({ filename, sourceReceipt, isVacancyOwned }) {
  if (typeof isVacancyOwned !== 'function') fail();
  const db = checkedDb(filename, true);
  try {
    const { eligible, ...plan } = calculate(db, sourceReceipt, isVacancyOwned);
    return plan;
  } finally { db.close(); }
}

export function promoteLegacySeen({ filename, sourceReceipt, isVacancyOwned,
  expectedCounts, expectedSelectionSha256, onStep = () => {} }) {
  if (typeof isVacancyOwned !== 'function' || typeof onStep !== 'function' ||
      !object(expectedCounts) || !/^[a-f0-9]{64}$/.test(expectedSelectionSha256)) fail();
  const db = checkedDb(filename, false);
  try {
    return db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS real_hh_seen (
        profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, resume_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL, PRIMARY KEY(profile_id,vacancy_id,resume_id))`);
      const plan = calculate(db, sourceReceipt, isVacancyOwned);
      if (!isDeepStrictEqual(plan.counts, expectedCounts) ||
          plan.selectionSha256 !== expectedSelectionSha256) fail();
      db.exec(`CREATE TABLE IF NOT EXISTS r03_legacy_seen_promotion (
        migration_id TEXT PRIMARY KEY, archive_sha256 TEXT NOT NULL,
        source_receipt_sha256 TEXT NOT NULL, selection_sha256 TEXT NOT NULL,
        counts TEXT NOT NULL, inserted INTEGER NOT NULL, advanced INTEGER NOT NULL)`);
      const prior = db.prepare('SELECT * FROM r03_legacy_seen_promotion WHERE migration_id=?').get(plan.migrationId);
      if (prior) {
        if (prior.archive_sha256 !== plan.archiveSha256 ||
            prior.source_receipt_sha256 !== plan.sourceReceiptSha256 ||
            prior.selection_sha256 !== plan.selectionSha256 ||
            !isDeepStrictEqual(JSON.parse(prior.counts), plan.counts)) fail();
        return { kind: 'replayed', ...plan, eligible: undefined,
          inserted: prior.inserted, advanced: prior.advanced };
      }
      const find = db.prepare('SELECT first_seen_at FROM real_hh_seen WHERE profile_id=? AND vacancy_id=? AND resume_id=?');
      const insert = db.prepare('INSERT INTO real_hh_seen VALUES(?,?,?,?)');
      const advance = db.prepare(`UPDATE real_hh_seen SET first_seen_at=?
        WHERE profile_id=? AND vacancy_id=? AND resume_id=?`);
      let inserted = 0, advanced = 0;
      for (const row of plan.eligible) {
        const old = find.get(row.profileId, row.vacancyId, row.resumeId);
        if (!old) {
          insert.run(row.profileId, row.vacancyId, row.resumeId, row.firstSeenAt);
          inserted++;
        } else if (row.firstSeenAt < old.first_seen_at) {
          advance.run(row.firstSeenAt, row.profileId, row.vacancyId, row.resumeId);
          advanced++;
        }
      }
      onStep('seen');
      db.prepare('INSERT INTO r03_legacy_seen_promotion VALUES(?,?,?,?,?,?,?)').run(
        plan.migrationId, plan.archiveSha256, plan.sourceReceiptSha256,
        plan.selectionSha256, JSON.stringify(plan.counts), inserted, advanced);
      onStep('receipt');
      return { kind: 'promoted', ...plan, eligible: undefined, inserted, advanced };
    }).immediate();
  } finally { db.close(); }
}
