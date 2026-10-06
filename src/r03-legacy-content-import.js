import { createHash } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const bound = (value, max) => Array.isArray(value) && value.length <= max;
const sourceFile = value => typeof value === 'string' && /^search-results-[A-Za-z0-9_-]+\.json$/.test(value);

// This is a private, quarantined content store. Import does not create an
// occurrence, manual-run acceptance receipt or current-search snapshot.
export class R03LegacyContentImporter {
  constructor({ filename, bindProfile, isVacancyOwned, onStep = () => {} }) {
    if (typeof filename !== 'string' || !filename || filename === ':memory:' ||
        statSync(dirname(filename)).mode & 0o077) throw new TypeError('private_import_filename_required');
    if (typeof bindProfile !== 'function' || typeof isVacancyOwned !== 'function' || typeof onStep !== 'function')
      throw new TypeError('private_import_ports_required');
    this.bindProfile = bindProfile;
    this.isVacancyOwned = isVacancyOwned;
    this.onStep = onStep;
    this.db = new Database(filename, { timeout: 5000 });
    chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS r03_legacy_content_import (
      migration_id TEXT NOT NULL, profile_id TEXT NOT NULL, source_digest TEXT NOT NULL,
      counts TEXT NOT NULL, source_receipts TEXT NOT NULL, PRIMARY KEY(migration_id, profile_id));
    CREATE TABLE IF NOT EXISTS r03_legacy_content_candidate (
      migration_id TEXT NOT NULL, profile_id TEXT NOT NULL, resume_id TEXT NOT NULL,
      vacancy_ids TEXT NOT NULL, wildcard_quarantined INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(migration_id, profile_id, resume_id));
    CREATE TABLE IF NOT EXISTS r03_legacy_content_seen (
      migration_id TEXT NOT NULL, profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL,
      resume_id TEXT NOT NULL, first_seen_at TEXT NOT NULL,
      PRIMARY KEY(migration_id, profile_id, vacancy_id, resume_id));
    CREATE TABLE IF NOT EXISTS r03_legacy_content_snapshot (
      migration_id TEXT NOT NULL, profile_id TEXT NOT NULL, source_file TEXT NOT NULL,
      vacancy_id TEXT NOT NULL, searched_at TEXT NOT NULL, candidate_ids TEXT NOT NULL,
      payload TEXT NOT NULL, acceptance_status TEXT NOT NULL CHECK(acceptance_status='quarantined'),
      PRIMARY KEY(migration_id, profile_id, source_file));
    CREATE TABLE IF NOT EXISTS r03_legacy_content_comment (
      migration_id TEXT NOT NULL, profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL,
      resume_id TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT,
      PRIMARY KEY(migration_id, profile_id, vacancy_id, resume_id));`);
    this.lookup = this.db.prepare('SELECT source_digest,counts,source_receipts FROM r03_legacy_content_import WHERE migration_id=? AND profile_id=?');
    this.addImport = this.db.prepare('INSERT INTO r03_legacy_content_import VALUES(?,?,?,?,?)');
    this.addCandidate = this.db.prepare('INSERT INTO r03_legacy_content_candidate VALUES(?,?,?,?,?,?)');
    this.addSeen = this.db.prepare('INSERT INTO r03_legacy_content_seen VALUES(?,?,?,?,?)');
    this.addSnapshot = this.db.prepare('INSERT INTO r03_legacy_content_snapshot VALUES(?,?,?,?,?,?,?,?)');
    this.addComment = this.db.prepare('INSERT INTO r03_legacy_content_comment VALUES(?,?,?,?,?,?)');
  }

  close() { this.db.close(); }

  plan(input) {
    const content = input && Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'sourceFiles'));
    if (!object(input) || !safeId(input.migrationId) || !safeId(input.sourceProfileRef) ||
        !object(input.allCandidates) || !object(input.seenIds) || !bound(input.snapshots, 1000) ||
        !object(input.comments) || !object(input.expectedCounts) || !object(input.sourceFiles) ||
        Object.keys(input).some(key => !['migrationId', 'sourceProfileRef', 'allCandidates', 'seenIds',
          'snapshots', 'comments', 'expectedCounts', 'sourceFiles'].includes(key)) ||
        Object.keys(input.allCandidates).length > 50_000 ||
        Object.keys(input.seenIds).length > 1000 || Object.keys(input.comments).length > 1000 ||
        Buffer.byteLength(JSON.stringify(content)) > 128 * 1024 * 1024)
      throw new Error('invalid_legacy_content_envelope');
    const profileId = this.bindProfile(input.sourceProfileRef);
    if (!safeId(profileId)) throw new Error('legacy_content_profile_binding_denied');
    const owned = vacancyId => safeId(vacancyId) && this.isVacancyOwned(profileId, vacancyId);
    const candidates = [];
    const candidateById = new Map();
    let wildcard = 0;
    for (const [id, record] of Object.entries(input.allCandidates)) {
      // Pre-vacancy legacy records may omit vacancy_ids entirely. Keep the raw
      // payload, but classify the missing assignment as quarantined wildcard.
      const vacancyIds = record?.vacancy_ids === undefined ? [] : record.vacancy_ids;
      if (!safeId(id) || !object(record) || record.id !== id ||
          !bound(vacancyIds, 1000) || new Set(vacancyIds).size !== vacancyIds.length ||
          vacancyIds.some(vacancyId => !owned(vacancyId)) ||
          record.vacancy_data !== undefined && (!object(record.vacancy_data) ||
            Object.keys(record.vacancy_data).some(vacancyId => !owned(vacancyId) ||
              vacancyIds.length > 0 && !vacancyIds.includes(vacancyId))) ||
          Buffer.byteLength(JSON.stringify(record)) > 128 * 1024)
        throw new Error('invalid_legacy_content_candidate');
      if (vacancyIds.length === 0) wildcard++;
      candidateById.set(id, vacancyIds);
      candidates.push({ id, record, vacancyIds });
    }
    const linked = (id, vacancyId) => candidateById.has(id) &&
      (candidateById.get(id).length === 0 || candidateById.get(id).includes(vacancyId));
    const seen = [];
    for (const [vacancyId, bucket] of Object.entries(input.seenIds)) {
      if (!owned(vacancyId) || !object(bucket)) throw new Error('invalid_legacy_content_seen');
      for (const [id, firstSeenAt] of Object.entries(bucket)) {
        if (!safeId(id) || !linked(id, vacancyId) || !validDate(firstSeenAt))
          throw new Error('invalid_legacy_content_seen');
        seen.push({ vacancyId, id, firstSeenAt });
      }
    }
    const snapshots = [];
    const files = new Set();
    for (const entry of input.snapshots) {
      const payload = entry?.payload;
      const vacancyId = String(payload?.vacancy_id ?? '');
      if (!sourceFile(entry?.sourceFile) || files.has(entry.sourceFile) || !object(payload) || !owned(vacancyId) ||
          !validDate(payload.searched_at) || !bound(payload.candidates, 20_000) ||
          payload.candidates.some(candidate => !object(candidate) || !safeId(candidate.id) ||
            !linked(candidate.id, vacancyId)) ||
          new Set(payload.candidates.map(candidate => candidate.id)).size !== payload.candidates.length ||
          Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024 * 1024)
        throw new Error('invalid_legacy_content_snapshot');
      files.add(entry.sourceFile);
      snapshots.push({ sourceFile: entry.sourceFile, vacancyId, payload });
    }
    const comments = [];
    for (const [vacancyId, bucket] of Object.entries(input.comments)) {
      if (!owned(vacancyId) || !object(bucket)) throw new Error('invalid_legacy_content_comment');
      for (const [id, row] of Object.entries(bucket)) {
        if (!safeId(id) || !linked(id, vacancyId) || !object(row) ||
            typeof row.text !== 'string' || row.text.length > 1000 ||
            row.updatedAt !== undefined && !validDate(row.updatedAt))
          throw new Error('invalid_legacy_content_comment');
        comments.push({ vacancyId, id, row });
      }
    }
    const counts = { allCandidates: candidates.length, seenIds: seen.length,
      snapshots: snapshots.length, comments: comments.length, wildcardQuarantined: wildcard };
    if (Object.keys(input.expectedCounts).length !== Object.keys(counts).length ||
        Object.entries(counts).some(([key, value]) => input.expectedCounts[key] !== value))
      throw new Error('legacy_content_count_mismatch');
    const expectedFiles = new Map([
      ['all-candidates.json', input.allCandidates], ['seen-ids.json', input.seenIds],
      ...snapshots.map(({ sourceFile, payload }) => [sourceFile, payload]),
      ...Object.entries(input.comments).map(([vacancyId, payload]) =>
        [`candidate-comments-${encodeURIComponent(vacancyId)}.json`, payload])
    ]);
    if (Object.keys(input.sourceFiles).length !== expectedFiles.size || expectedFiles.size > 2002)
      throw new Error('legacy_content_source_files_mismatch');
    const sourceReceipts = [];
    let totalBytes = 0;
    for (const [file, payload] of [...expectedFiles].sort(([a], [b]) => a.localeCompare(b))) {
      const bytes = input.sourceFiles[file];
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 32 * 1024 * 1024)
        throw new Error('legacy_content_source_files_mismatch');
      totalBytes += bytes.length;
      if (totalBytes > 128 * 1024 * 1024) throw new Error('legacy_content_source_files_too_large');
      let parsed;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('legacy_content_source_json_invalid'); }
      if (!isDeepStrictEqual(parsed, payload)) throw new Error('legacy_content_source_bytes_mismatch');
      sourceReceipts.push({ file, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return { migrationId: input.migrationId, profileId,
      sourceDigest: digest([content, sourceReceipts]), sourceReceipts, counts,
      candidates, seen, snapshots, comments };
  }

  import(input) {
    const plan = this.plan(input);
    const { migrationId, profileId, sourceDigest, sourceReceipts, counts } = plan;
    return this.db.transaction(() => {
      const previous = this.lookup.get(migrationId, profileId);
      if (previous) return previous.source_digest === sourceDigest
        ? { kind: 'replayed', migrationId, profileId, sourceDigest, counts: JSON.parse(previous.counts),
          sourceReceipts: JSON.parse(previous.source_receipts) }
        : { kind: 'conflict', migrationId, profileId };
      for (const { id, record, vacancyIds } of plan.candidates) {
        this.addCandidate.run(migrationId, profileId, id, JSON.stringify(vacancyIds),
          vacancyIds.length === 0 ? 1 : 0, JSON.stringify(record));
      }
      this.onStep('candidates');
      for (const { vacancyId, id, firstSeenAt } of plan.seen)
        this.addSeen.run(migrationId, profileId, vacancyId, id, firstSeenAt);
      this.onStep('seen');
      for (const { sourceFile, vacancyId, payload } of plan.snapshots)
        this.addSnapshot.run(migrationId, profileId, sourceFile, vacancyId, payload.searched_at,
          JSON.stringify(payload.candidates.map(candidate => candidate.id)), JSON.stringify(payload), 'quarantined');
      this.onStep('snapshots');
      for (const { vacancyId, id, row } of plan.comments)
        this.addComment.run(migrationId, profileId, vacancyId, id, row.text, row.updatedAt ?? null);
      this.onStep('comments');
      this.addImport.run(migrationId, profileId, sourceDigest, JSON.stringify(counts), JSON.stringify(sourceReceipts));
      return { kind: 'imported', migrationId, profileId, sourceDigest, counts, sourceReceipts };
    }).immediate();
  }
}
