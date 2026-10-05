import { createHash } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export const REAL_HH_RESULT_VERSION = 'hh-result-v1';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const isoTime = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = new Set(['id', 'vacancyId', 'hhUrl', 'title', 'firstName', 'lastName', 'age', 'area', 'totalExperienceMonths', 'totalExperienceYears', 'salary', 'recentCompanies', 'experience', 'preScore', 'preScoreSignals', 'preTag', 'totalPossible', 'atsScore', 'atsTag', 'knockout']);
const experienceFields = new Set(['position', 'company', 'start', 'end']);
const salaryFields = new Set(['amount', 'from', 'to', 'currency', 'gross']);
const searchFields = new Set(['version', 'profileId', 'vacancyId', 'jobId', 'searchedAt', 'criteriaRevision', 'sourceRevision', 'source', 'totalCollected', 'candidates']);
const ownKeysOnly = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.has(key));

function validateCandidate(candidate, vacancyId) {
  if (!ownKeysOnly(candidate, fields) || Object.keys(candidate).length !== fields.size || !safeId(candidate.id) || candidate.vacancyId !== vacancyId ||
      typeof candidate.hhUrl !== 'string' || !/^https:\/\/(?:www\.)?hh\.ru\/resume\/[A-Za-z0-9]+(?:[?#].*)?$/.test(candidate.hhUrl) ||
      !['title', 'firstName', 'lastName', 'area'].every(key => typeof candidate[key] === 'string') ||
      !Number.isSafeInteger(candidate.totalExperienceMonths) || candidate.totalExperienceMonths < 0 ||
      !Number.isFinite(candidate.totalExperienceYears) || candidate.totalExperienceYears < 0 ||
      !Number.isFinite(candidate.preScore) || candidate.preScore < 0 || !Number.isFinite(candidate.totalPossible) || candidate.totalPossible < 0 ||
      !Array.isArray(candidate.preScoreSignals) || candidate.preScoreSignals.some(value => typeof value !== 'string') ||
      !['PASS', 'REVIEW', 'WEAK'].includes(candidate.preTag) ||
      candidate.atsScore !== null || candidate.atsTag !== null ||
      !ownKeysOnly(candidate.knockout, new Set(['status', 'criteria'])) || candidate.knockout.status !== 'pending_ai' ||
      !Array.isArray(candidate.knockout.criteria) || candidate.knockout.criteria.some(value => typeof value !== 'string') ||
      !Array.isArray(candidate.recentCompanies) || candidate.recentCompanies.some(value => typeof value !== 'string') ||
      !Array.isArray(candidate.experience) || candidate.experience.length > 5 || candidate.experience.some(value => !ownKeysOnly(value, experienceFields) ||
        !['position', 'company', 'start'].every(key => typeof value[key] === 'string') || value.end !== null && typeof value.end !== 'string') ||
      candidate.age !== null && (!Number.isSafeInteger(candidate.age) || candidate.age < 0)) throw new TypeError('invalid_real_hh_candidate');
  if (candidate.salary !== null && (!ownKeysOnly(candidate.salary, salaryFields) ||
      ['amount', 'from', 'to'].some(key => candidate.salary[key] !== undefined && (!Number.isFinite(candidate.salary[key]) || candidate.salary[key] < 0)) ||
      candidate.salary.currency !== undefined && typeof candidate.salary.currency !== 'string' ||
      candidate.salary.gross !== undefined && candidate.salary.gross !== null && typeof candidate.salary.gross !== 'boolean')) throw new TypeError('invalid_real_hh_candidate_salary');
  if (Buffer.byteLength(JSON.stringify(candidate)) > 32_768) throw new TypeError('real_hh_candidate_too_large');
}

function validatedSearch(input) {
  if (!ownKeysOnly(input, searchFields) || Object.keys(input).length !== searchFields.size || input.version !== REAL_HH_RESULT_VERSION || ![input.profileId, input.vacancyId, input.jobId].every(safeId) ||
      !isoTime(input.searchedAt) || typeof input.criteriaRevision !== 'string' || !input.criteriaRevision ||
      typeof input.sourceRevision !== 'string' || !input.sourceRevision || !['manual', 'scheduled'].includes(input.source) ||
      !Number.isSafeInteger(input.totalCollected) || input.totalCollected < 0 || !Array.isArray(input.candidates) ||
      input.candidates.length > 20_000 || input.totalCollected < input.candidates.length) throw new TypeError('invalid_real_hh_search');
  const ids = new Set();
  for (const candidate of input.candidates) {
    validateCandidate(candidate, input.vacancyId);
    if (ids.has(candidate.id)) throw new TypeError('duplicate_real_hh_resume_id');
    ids.add(candidate.id);
  }
  const candidates = [...input.candidates].sort((a, b) => b.preScore - a.preScore || a.id.localeCompare(b.id));
  return { ...input, candidates };
}

function decodeCursor(cursor, jobId, revision) {
  if (cursor === null) return 0;
  let data;
  try { data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new TypeError('invalid_result_cursor'); }
  if (data.jobId !== jobId || data.revision !== revision || !Number.isSafeInteger(data.offset) || data.offset < 0) throw new TypeError('invalid_result_cursor');
  return data.offset;
}

export class SqliteRealHhCandidateState {
  constructor({ filename, isVacancyOwned, onStep = () => {} }) {
    if (typeof filename !== 'string' || !filename || filename === ':memory:') throw new TypeError('private durable filename required');
    if (statSync(dirname(filename)).mode & 0o077) throw new Error('real HH candidate directory must be owner-only (0700)');
    if (typeof isVacancyOwned !== 'function' || typeof onStep !== 'function') throw new TypeError('ownership and onStep ports required');
    this.isVacancyOwned = isVacancyOwned;
    this.onStep = onStep;
    this.db = new Database(filename, { timeout: 5000 });
    chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS real_hh_candidate (
      profile_id TEXT NOT NULL, resume_id TEXT NOT NULL, latest_projection TEXT NOT NULL,
      first_found_at TEXT NOT NULL, PRIMARY KEY (profile_id, resume_id));
    CREATE TABLE IF NOT EXISTS real_hh_seen (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, resume_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, PRIMARY KEY (profile_id, vacancy_id, resume_id));
    CREATE TABLE IF NOT EXISTS real_hh_snapshot (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, job_id TEXT NOT NULL,
      result_version TEXT NOT NULL, searched_at TEXT NOT NULL, criteria_revision TEXT NOT NULL,
      source_revision TEXT NOT NULL, source TEXT NOT NULL, input_digest TEXT NOT NULL,
      result_revision TEXT NOT NULL, total_collected INTEGER NOT NULL, candidate_count INTEGER NOT NULL,
      new_count INTEGER NOT NULL, PRIMARY KEY (profile_id, vacancy_id, job_id));
    CREATE TABLE IF NOT EXISTS real_hh_snapshot_member (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, job_id TEXT NOT NULL,
      position INTEGER NOT NULL, resume_id TEXT NOT NULL, projection TEXT NOT NULL,
      PRIMARY KEY (profile_id, vacancy_id, job_id, position),
      UNIQUE (profile_id, vacancy_id, job_id, resume_id));
    CREATE INDEX IF NOT EXISTS real_hh_snapshot_latest ON real_hh_snapshot(profile_id, vacancy_id, searched_at DESC, job_id DESC);`);
    this.getSnapshot = this.db.prepare('SELECT * FROM real_hh_snapshot WHERE profile_id=? AND vacancy_id=? AND job_id=?');
    this.getJobAnywhere = this.db.prepare('SELECT profile_id, vacancy_id FROM real_hh_snapshot WHERE job_id=? LIMIT 1');
    this.insertCandidate = this.db.prepare(`INSERT INTO real_hh_candidate(profile_id,resume_id,latest_projection,first_found_at) VALUES(?,?,?,?)
      ON CONFLICT(profile_id,resume_id) DO UPDATE SET latest_projection=excluded.latest_projection`);
    this.insertSeen = this.db.prepare('INSERT OR IGNORE INTO real_hh_seen(profile_id,vacancy_id,resume_id,first_seen_at) VALUES(?,?,?,?)');
    this.insertSnapshot = this.db.prepare(`INSERT INTO real_hh_snapshot(profile_id,vacancy_id,job_id,result_version,searched_at,criteria_revision,source_revision,source,input_digest,result_revision,total_collected,candidate_count,new_count)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.insertMember = this.db.prepare('INSERT INTO real_hh_snapshot_member(profile_id,vacancy_id,job_id,position,resume_id,projection) VALUES(?,?,?,?,?,?)');
    this.latest = this.db.prepare('SELECT * FROM real_hh_snapshot WHERE profile_id=? AND vacancy_id=? ORDER BY searched_at DESC, job_id DESC LIMIT 1');
    this.members = this.db.prepare('SELECT projection FROM real_hh_snapshot_member WHERE profile_id=? AND vacancy_id=? AND job_id=? AND position>=? ORDER BY position LIMIT ?');
    this.seenCount = this.db.prepare('SELECT COUNT(*) AS count FROM real_hh_seen WHERE profile_id=? AND vacancy_id=?');
  }

  close() { this.db.close(); }
  assertScope(profileId, vacancyId) {
    if (!safeId(profileId) || !safeId(vacancyId) || !this.isVacancyOwned(profileId, vacancyId)) throw new Error('real_hh_scope_denied');
  }
  publicSnapshot(row) {
    if (!row) return null;
    return { version: row.result_version, profileId: row.profile_id, vacancyId: row.vacancy_id, jobId: row.job_id,
      searchedAt: row.searched_at, criteriaRevision: row.criteria_revision, sourceRevision: row.source_revision,
      source: row.source, resultRevision: row.result_revision, totalCollected: row.total_collected,
      candidateCount: row.candidate_count, newCount: row.new_count };
  }
  recordCompletedSearch(search) {
    const input = validatedSearch(search);
    this.assertScope(input.profileId, input.vacancyId);
    const digest = hash({ ...input, candidates: input.candidates });
    const revision = hash([input.jobId, input.criteriaRevision, input.sourceRevision, input.candidates.map(item => item.id)]).slice(0, 24);
    return this.db.transaction(() => {
      const crossScope = this.getJobAnywhere.get(input.jobId);
      if (crossScope && (crossScope.profile_id !== input.profileId || crossScope.vacancy_id !== input.vacancyId)) throw new Error('real_hh_job_scope_conflict');
      const prior = this.getSnapshot.get(input.profileId, input.vacancyId, input.jobId);
      if (prior) {
        if (prior.input_digest !== digest) throw new Error('real_hh_job_conflict');
        return this.publicSnapshot(prior);
      }
      let newCount = 0;
      for (const candidate of input.candidates) {
        this.insertCandidate.run(input.profileId, candidate.id, JSON.stringify(candidate), input.searchedAt);
        if (this.insertSeen.run(input.profileId, input.vacancyId, candidate.id, input.searchedAt).changes) newCount++;
      }
      this.onStep('candidate_and_seen');
      this.insertSnapshot.run(input.profileId, input.vacancyId, input.jobId, REAL_HH_RESULT_VERSION,
        input.searchedAt, input.criteriaRevision, input.sourceRevision, input.source, digest, revision,
        input.totalCollected, input.candidates.length, newCount);
      input.candidates.forEach((candidate, position) => this.insertMember.run(input.profileId, input.vacancyId, input.jobId, position, candidate.id, JSON.stringify(candidate)));
      this.onStep('snapshot');
      return this.publicSnapshot(this.getSnapshot.get(input.profileId, input.vacancyId, input.jobId));
    }).immediate();
  }
  latestSnapshot(profileId, vacancyId) {
    this.assertScope(profileId, vacancyId);
    return this.publicSnapshot(this.latest.get(profileId, vacancyId));
  }
  resultPage({ profileId, vacancyId, jobId, cursor = null, limit = 50 }) {
    this.assertScope(profileId, vacancyId);
    if (!safeId(jobId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid_real_hh_page_request');
    const row = this.getSnapshot.get(profileId, vacancyId, jobId);
    if (!row) return null;
    const offset = decodeCursor(cursor, jobId, row.result_revision);
    if (offset > row.candidate_count) throw new TypeError('invalid_result_cursor');
    const items = this.members.all(profileId, vacancyId, jobId, offset, limit).map(item => JSON.parse(item.projection));
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < row.candidate_count ? Buffer.from(JSON.stringify({ jobId, revision: row.result_revision, offset: nextOffset })).toString('base64url') : null;
    return { snapshot: this.publicSnapshot(row), items, nextCursor };
  }
  seenTotal(profileId, vacancyId) {
    this.assertScope(profileId, vacancyId);
    return this.seenCount.get(profileId, vacancyId).count;
  }
}
