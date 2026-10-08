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
const searchFields = new Set(['version', 'profileId', 'vacancyId', 'jobId', 'searchedAt', 'criteriaRevision', 'sourceRevision', 'source', 'totalCollected', 'candidates', 'expectedFeedbackRevision']);
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
  if (!ownKeysOnly(input, searchFields) || Object.keys(input).length !== searchFields.size - (input.expectedFeedbackRevision === undefined ? 1 : 0) ||
      input.expectedFeedbackRevision !== undefined && !/^[a-f0-9]{24}$/.test(input.expectedFeedbackRevision) ||
      input.version !== REAL_HH_RESULT_VERSION || ![input.profileId, input.vacancyId, input.jobId].every(safeId) ||
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
    CREATE TABLE IF NOT EXISTS real_hh_manual_candidate (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, resume_id TEXT NOT NULL,
      projection TEXT NOT NULL, added_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, vacancy_id, resume_id));
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
    CREATE TABLE IF NOT EXISTS real_hh_assessment (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, job_id TEXT NOT NULL,
      resume_id TEXT NOT NULL, input_revision TEXT NOT NULL, assessment TEXT NOT NULL,
      assessed_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, vacancy_id, job_id, resume_id));
    CREATE TABLE IF NOT EXISTS real_hh_assessment_failure (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, resume_id TEXT NOT NULL,
      input_revision TEXT NOT NULL, failures INTEGER NOT NULL, retry_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, vacancy_id, resume_id, input_revision));
    CREATE TABLE IF NOT EXISTS real_hh_candidate_overlay (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, resume_id TEXT NOT NULL,
      revision INTEGER NOT NULL, status TEXT NOT NULL, comment TEXT,
      exclude_from_search INTEGER NOT NULL,
      PRIMARY KEY (profile_id, vacancy_id, resume_id));
    CREATE TABLE IF NOT EXISTS real_hh_feedback_query_cache (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, base_revision TEXT NOT NULL,
      feedback_revision TEXT NOT NULL, queries TEXT NOT NULL,
      PRIMARY KEY (profile_id, vacancy_id, base_revision, feedback_revision));
    CREATE INDEX IF NOT EXISTS real_hh_snapshot_latest ON real_hh_snapshot(profile_id, vacancy_id, searched_at DESC, job_id DESC);`);
    this.getSnapshot = this.db.prepare('SELECT * FROM real_hh_snapshot WHERE profile_id=? AND vacancy_id=? AND job_id=?');
    this.getJobAnywhere = this.db.prepare('SELECT profile_id, vacancy_id FROM real_hh_snapshot WHERE job_id=? LIMIT 1');
    this.insertCandidate = this.db.prepare(`INSERT INTO real_hh_candidate(profile_id,resume_id,latest_projection,first_found_at) VALUES(?,?,?,?)
      ON CONFLICT(profile_id,resume_id) DO UPDATE SET latest_projection=excluded.latest_projection`);
    this.insertSeen = this.db.prepare('INSERT OR IGNORE INTO real_hh_seen(profile_id,vacancy_id,resume_id,first_seen_at) VALUES(?,?,?,?)');
    this.insertManualCandidate = this.db.prepare(`INSERT OR IGNORE INTO real_hh_manual_candidate
      (profile_id,vacancy_id,resume_id,projection,added_at) VALUES(?,?,?,?,?)`);
    this.manualCandidates = this.db.prepare(`SELECT resume_id,projection,added_at AS searched_at,
      NULL AS job_id,'manual_add' AS source,NULL AS criteria_revision,NULL AS source_revision
      FROM real_hh_manual_candidate WHERE profile_id=? AND vacancy_id=?`);
    this.manualCandidateById = this.db.prepare(`SELECT 1 AS present FROM real_hh_manual_candidate
      WHERE profile_id=? AND vacancy_id=? AND resume_id=?`);
    this.insertSnapshot = this.db.prepare(`INSERT INTO real_hh_snapshot(profile_id,vacancy_id,job_id,result_version,searched_at,criteria_revision,source_revision,source,input_digest,result_revision,total_collected,candidate_count,new_count)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.insertMember = this.db.prepare('INSERT INTO real_hh_snapshot_member(profile_id,vacancy_id,job_id,position,resume_id,projection) VALUES(?,?,?,?,?,?)');
    this.latest = this.db.prepare('SELECT * FROM real_hh_snapshot WHERE profile_id=? AND vacancy_id=? ORDER BY searched_at DESC, job_id DESC LIMIT 1');
    this.members = this.db.prepare('SELECT projection FROM real_hh_snapshot_member WHERE profile_id=? AND vacancy_id=? AND job_id=? AND position>=? ORDER BY position LIMIT ?');
    this.seenCount = this.db.prepare('SELECT COUNT(*) AS count FROM real_hh_seen WHERE profile_id=? AND vacancy_id=?');
    this.pendingAssessments = this.db.prepare(`SELECT m.resume_id, m.projection, a.input_revision
      FROM real_hh_snapshot_member m LEFT JOIN real_hh_assessment a
      ON a.profile_id=m.profile_id AND a.vacancy_id=m.vacancy_id AND a.job_id=m.job_id AND a.resume_id=m.resume_id
      WHERE m.profile_id=? AND m.vacancy_id=? AND m.job_id=? ORDER BY m.position`);
    this.memberById = this.db.prepare(`SELECT projection FROM real_hh_snapshot_member
      WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`);
    this.insertAssessment = this.db.prepare(`INSERT OR IGNORE INTO real_hh_assessment
      (profile_id,vacancy_id,job_id,resume_id,input_revision,assessment,assessed_at) VALUES(?,?,?,?,?,?,?)`);
    this.assessmentById = this.db.prepare(`SELECT input_revision, assessment FROM real_hh_assessment
      WHERE profile_id=? AND vacancy_id=? AND job_id=? AND resume_id=?`);
    this.reusableAssessment = this.db.prepare(`SELECT assessment, assessed_at FROM real_hh_assessment
      WHERE profile_id=? AND vacancy_id=? AND resume_id=? AND input_revision=?
      ORDER BY assessed_at DESC, job_id DESC LIMIT 1`);
    this.assessmentFailure = this.db.prepare(`SELECT failures,retry_at FROM real_hh_assessment_failure
      WHERE profile_id=? AND vacancy_id=? AND resume_id=? AND input_revision=?`);
    this.upsertAssessmentFailure = this.db.prepare(`INSERT INTO real_hh_assessment_failure
      (profile_id,vacancy_id,resume_id,input_revision,failures,retry_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(profile_id,vacancy_id,resume_id,input_revision) DO UPDATE SET
      failures=excluded.failures,retry_at=excluded.retry_at`);
    this.clearAssessmentFailure = this.db.prepare(`DELETE FROM real_hh_assessment_failure
      WHERE profile_id=? AND vacancy_id=? AND resume_id=? AND input_revision=?`);
    this.overlayById = this.db.prepare(`SELECT revision,status,comment,exclude_from_search FROM real_hh_candidate_overlay
      WHERE profile_id=? AND vacancy_id=? AND resume_id=?`);
    this.upsertOverlay = this.db.prepare(`INSERT INTO real_hh_candidate_overlay(profile_id,vacancy_id,resume_id,revision,status,comment,exclude_from_search)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_id,vacancy_id,resume_id) DO UPDATE SET
      revision=excluded.revision,status=excluded.status,comment=excluded.comment,exclude_from_search=excluded.exclude_from_search`);
    this.feedbackRows = this.db.prepare(`SELECT resume_id,revision,status,comment,exclude_from_search
      FROM real_hh_candidate_overlay WHERE profile_id=? AND vacancy_id=? ORDER BY resume_id`);
    this.feedbackQueries = this.db.prepare(`SELECT queries FROM real_hh_feedback_query_cache
      WHERE profile_id=? AND vacancy_id=? AND base_revision=? AND feedback_revision=?`);
    this.insertFeedbackQueries = this.db.prepare(`INSERT OR IGNORE INTO real_hh_feedback_query_cache
      (profile_id,vacancy_id,base_revision,feedback_revision,queries) VALUES(?,?,?,?,?)`);
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
      if (input.expectedFeedbackRevision !== undefined &&
          this.searchFeedback(input.profileId, input.vacancyId).revision !== input.expectedFeedbackRevision)
        throw new Error('search_feedback_stale');
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
      const snapshot = this.publicSnapshot(this.getSnapshot.get(input.profileId, input.vacancyId, input.jobId));
      input.candidates.forEach((candidate, position) => {
        this.insertMember.run(input.profileId, input.vacancyId, input.jobId, position, candidate.id, JSON.stringify(candidate));
        const inputRevision = this.assessmentInputRevision(snapshot, candidate);
        const reused = this.reusableAssessment.get(input.profileId, input.vacancyId, candidate.id, inputRevision);
        if (reused) this.insertAssessment.run(input.profileId, input.vacancyId, input.jobId, candidate.id,
          inputRevision, reused.assessment, reused.assessed_at);
      });
      this.onStep('snapshot');
      return snapshot;
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
  addManualCandidate({ profileId, vacancyId, candidate, addedAt }) {
    this.assertScope(profileId, vacancyId);
    validateCandidate(candidate, vacancyId);
    if (!isoTime(addedAt)) throw new TypeError('invalid_manual_candidate_time');
    return this.db.transaction(() => {
      const added = this.insertManualCandidate.run(profileId, vacancyId, candidate.id,
        JSON.stringify(candidate), addedAt).changes === 1;
      if (added) this.insertCandidate.run(profileId, candidate.id, JSON.stringify(candidate), addedAt);
      this.onStep('manual_candidate');
      return { added, candidateId: candidate.id };
    }).immediate();
  }
  hasManualCandidate(profileId, vacancyId, candidateId) {
    this.assertScope(profileId, vacancyId);
    if (!safeId(candidateId)) throw new TypeError('invalid_manual_candidate_id');
    return Boolean(this.manualCandidateById.get(profileId, vacancyId, candidateId));
  }
  importSeen({ profileId, vacancyId, ids, importedAt }) {
    this.assertScope(profileId, vacancyId);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 ||
        ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(id)) ||
        !isoTime(importedAt)) throw new TypeError('invalid_seen_import');
    const unique = [...new Set(ids)];
    return this.db.transaction(() => {
      let imported = 0;
      for (const id of unique)
        imported += this.insertSeen.run(profileId, vacancyId, id, importedAt).changes;
      this.onStep('import_seen');
      return { imported, total: this.seenCount.get(profileId, vacancyId).count };
    }).immediate();
  }
  assessmentInputRevision(snapshot, candidate) {
    return hash([snapshot.criteriaRevision, snapshot.sourceRevision, candidate]).slice(0, 32);
  }
  unassessedLatest({ profileId, vacancyId, limit = 10, at = new Date().toISOString() }) {
    this.assertScope(profileId, vacancyId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !isoTime(at)) throw new TypeError('invalid_assessment_limit');
    const snapshot = this.latestSnapshot(profileId, vacancyId);
    if (!snapshot) return [];
    const pending = [];
    for (const row of this.pendingAssessments.all(profileId, vacancyId, snapshot.jobId)) {
      const candidate = JSON.parse(row.projection);
      const inputRevision = this.assessmentInputRevision(snapshot, candidate);
      if (row.input_revision === inputRevision) continue;
      const failure = this.assessmentFailure.get(profileId, vacancyId, candidate.id, inputRevision);
      if (failure && failure.retry_at > at) continue;
      pending.push({ snapshot, candidate, inputRevision });
      if (pending.length === limit) break;
    }
    return pending;
  }
  assessmentForLatest({ profileId, vacancyId, jobId, candidateId, at = new Date().toISOString() }) {
    this.assertScope(profileId, vacancyId);
    if (![jobId, candidateId].every(safeId) || !isoTime(at)) throw new TypeError('invalid_assessment_target');
    const snapshot = this.latestSnapshot(profileId, vacancyId);
    if (!snapshot || snapshot.jobId !== jobId) return { kind: 'stale' };
    const row = this.memberById.get(profileId, vacancyId, jobId, candidateId);
    if (!row) return { kind: 'not_found' };
    const candidate = JSON.parse(row.projection);
    const inputRevision = this.assessmentInputRevision(snapshot, candidate);
    const prior = this.assessmentById.get(profileId, vacancyId, jobId, candidateId);
    if (prior?.input_revision === inputRevision)
      return { kind: 'scored', snapshot, candidate, inputRevision, assessment: JSON.parse(prior.assessment) };
    const failure = this.assessmentFailure.get(profileId, vacancyId, candidateId, inputRevision);
    if (failure?.retry_at > at) return { kind: 'retry_later', retryAt: failure.retry_at };
    return { kind: 'pending', snapshot, candidate, inputRevision };
  }
  assessmentForSnapshot({ profileId, vacancyId, jobId, candidateId }) {
    this.assertScope(profileId, vacancyId);
    if (![jobId, candidateId].every(safeId)) throw new TypeError('invalid_assessment_target');
    const row = this.getSnapshot.get(profileId, vacancyId, jobId);
    if (!row) return { kind: 'not_found' };
    const snapshot = this.publicSnapshot(row);
    const member = this.memberById.get(profileId, vacancyId, jobId, candidateId);
    if (!member) return { kind: 'not_found' };
    const candidate = JSON.parse(member.projection);
    const inputRevision = this.assessmentInputRevision(snapshot, candidate);
    const prior = this.assessmentById.get(profileId, vacancyId, jobId, candidateId);
    if (prior?.input_revision !== inputRevision) return { kind: 'pending', snapshot, candidate, inputRevision };
    return { kind: 'scored', snapshot, candidate, inputRevision,
      assessment: JSON.parse(prior.assessment) };
  }
  candidateOverlayFor({ profileId, vacancyId, candidateId }) {
    this.assertScope(profileId, vacancyId);
    if (!safeId(candidateId)) throw new TypeError('invalid_candidate_overlay_target');
    const row = this.overlayById.get(profileId, vacancyId, candidateId);
    return { status: row?.status ?? 'active', revision: row?.revision ?? 0,
      comment: row?.comment ?? null, excludeFromSearch: Boolean(row?.exclude_from_search) };
  }
  recordAssessmentFailure({ profileId, vacancyId, jobId, candidateId, inputRevision, failedAt }) {
    this.assertScope(profileId, vacancyId);
    if (![jobId, candidateId].every(safeId) || !/^[a-f0-9]{32}$/.test(inputRevision) || !isoTime(failedAt))
      throw new TypeError('invalid_assessment_failure');
    return this.db.transaction(() => {
      const snapshot = this.latestSnapshot(profileId, vacancyId);
      if (!snapshot || snapshot.jobId !== jobId) return { kind: 'stale' };
      const member = this.memberById.get(profileId, vacancyId, jobId, candidateId);
      if (!member || this.assessmentInputRevision(snapshot, JSON.parse(member.projection)) !== inputRevision ||
          this.assessmentById.get(profileId, vacancyId, jobId, candidateId)?.input_revision === inputRevision)
        return { kind: 'stale' };
      const prior = this.assessmentFailure.get(profileId, vacancyId, candidateId, inputRevision);
      const failures = Math.min((prior?.failures ?? 0) + 1, 20);
      const delayMs = Math.min(15 * 60_000 * 2 ** (failures - 1), 24 * 60 * 60_000);
      const retryAt = new Date(Date.parse(failedAt) + delayMs).toISOString();
      this.upsertAssessmentFailure.run(profileId, vacancyId, candidateId, inputRevision, failures, retryAt);
      return { kind: 'deferred', failures, retryAt };
    }).immediate();
  }
  recordAssessment({ profileId, vacancyId, jobId, candidateId, inputRevision, assessment, assessedAt }) {
    this.assertScope(profileId, vacancyId);
    if (![jobId, candidateId].every(safeId) || typeof inputRevision !== 'string' || !/^[a-f0-9]{32}$/.test(inputRevision) || !isoTime(assessedAt) ||
        !ownKeysOnly(assessment, new Set(['atsScore', 'atsTag', 'knockout'])) || Object.keys(assessment).length !== 3 ||
        !Number.isFinite(assessment.atsScore) || assessment.atsScore < 0 || assessment.atsScore > 10 ||
        !['PASS', 'REVIEW', 'WEAK'].includes(assessment.atsTag) ||
        !ownKeysOnly(assessment.knockout, new Set(['status', 'criteria'])) ||
        !['passed', 'failed'].includes(assessment.knockout.status) || !Array.isArray(assessment.knockout.criteria) ||
        assessment.knockout.criteria.length > 20 || assessment.knockout.criteria.some(item => typeof item !== 'string' || item.length > 200) ||
        assessment.knockout.status === 'failed' && (assessment.knockout.criteria.length === 0 || assessment.atsScore > 2) ||
        assessment.knockout.status === 'passed' && assessment.knockout.criteria.length > 0 ||
        Buffer.byteLength(JSON.stringify(assessment)) > 8192) throw new TypeError('invalid_real_hh_assessment');
    return this.db.transaction(() => {
      const snapshot = this.latestSnapshot(profileId, vacancyId);
      if (!snapshot || snapshot.jobId !== jobId) return { kind: 'stale' };
      const row = this.memberById.get(profileId, vacancyId, jobId, candidateId);
      if (!row || this.assessmentInputRevision(snapshot, JSON.parse(row.projection)) !== inputRevision) return { kind: 'stale' };
      const prior = this.assessmentById.get(profileId, vacancyId, jobId, candidateId);
      if (prior) return prior.input_revision === inputRevision ? { kind: 'already_scored' } : { kind: 'stale' };
      this.insertAssessment.run(profileId, vacancyId, jobId, candidateId, inputRevision, JSON.stringify(assessment), assessedAt);
      this.clearAssessmentFailure.run(profileId, vacancyId, candidateId, inputRevision);
      return { kind: 'written' };
    }).immediate();
  }
  assessedResultPage(request) {
    const page = this.resultPage(request);
    if (!page) return null;
    return { ...page, items: page.items.map(candidate => {
      const row = this.assessmentById.get(request.profileId, request.vacancyId, request.jobId, candidate.id);
      if (!row || row.input_revision !== this.assessmentInputRevision(page.snapshot, candidate)) return candidate;
      return { ...candidate, ...JSON.parse(row.assessment) };
    }) };
  }
  acceptedCandidateFeed({ profileId, vacancyId, acceptedScheduledJobIds = [], acceptedManualJobIds = [] }) {
    this.assertScope(profileId, vacancyId);
    if (!Array.isArray(acceptedScheduledJobIds) || acceptedScheduledJobIds.length > 1000 ||
        acceptedScheduledJobIds.some(id => !safeId(id)) || !Array.isArray(acceptedManualJobIds) ||
        acceptedManualJobIds.length > 1000 || acceptedManualJobIds.some(id => !safeId(id))) throw new TypeError('invalid_accepted_job_ids');
    const scheduled = [...new Set(acceptedScheduledJobIds)];
    const manual = [...new Set(acceptedManualJobIds)];
    const scheduledClause = scheduled.length ? `(s.source='scheduled' AND s.job_id IN (${scheduled.map(() => '?').join(',')}))` : '0';
    const manualClause = manual.length ? `(s.source='manual' AND s.job_id IN (${manual.map(() => '?').join(',')}))` : '0';
    const rows = this.db.prepare(`SELECT s.job_id,s.source,s.searched_at,s.criteria_revision,s.source_revision,m.resume_id,m.projection
      FROM real_hh_snapshot s JOIN real_hh_snapshot_member m
      ON m.profile_id=s.profile_id AND m.vacancy_id=s.vacancy_id AND m.job_id=s.job_id
      WHERE s.profile_id=? AND s.vacancy_id=? AND (${scheduledClause} OR ${manualClause})
      ORDER BY s.searched_at DESC,s.job_id DESC,m.position LIMIT 50001`).all(profileId, vacancyId, ...scheduled, ...manual);
    const manualRows = this.manualCandidates.all(profileId, vacancyId);
    if (rows.length + manualRows.length > 50000) throw new Error('real_hh_feed_capacity_exceeded');
    const byResume = new Map();
    for (const row of [...rows, ...manualRows].sort((a, b) => b.searched_at.localeCompare(a.searched_at) ||
      String(b.job_id ?? '').localeCompare(String(a.job_id ?? '')))) {
      if (byResume.has(row.resume_id)) continue;
      const candidate = JSON.parse(row.projection);
      const snapshot = { criteriaRevision: row.criteria_revision, sourceRevision: row.source_revision };
      const assessmentRow = row.job_id === null ? null : this.assessmentById.get(profileId, vacancyId, row.job_id, row.resume_id);
      const assessment = assessmentRow?.input_revision === this.assessmentInputRevision(snapshot, candidate)
        ? JSON.parse(assessmentRow.assessment) : null;
      const overlay = this.overlayById.get(profileId, vacancyId, row.resume_id);
      byResume.set(row.resume_id, { ...candidate, ...(assessment ?? {}), source: row.source,
        jobId: row.job_id, lastFoundAt: row.searched_at,
        review: { status: overlay?.status ?? 'active', revision: overlay?.revision ?? 0 },
        comment: overlay?.comment ?? null, excludeFromSearch: Boolean(overlay?.exclude_from_search) });
    }
    return [...byResume.values()].sort((a, b) => (b.atsScore ?? -1) - (a.atsScore ?? -1) ||
      b.preScore - a.preScore || a.id.localeCompare(b.id));
  }
  updateCandidateOverlay({ profileId, vacancyId, candidateId, expectedRevision, status, comment, excludeFromSearch }) {
    this.assertScope(profileId, vacancyId);
    if (!safeId(candidateId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !['active', 'starred', 'archived'].includes(status) ||
        comment !== null && (typeof comment !== 'string' || comment.length > 1000) ||
        typeof excludeFromSearch !== 'boolean') throw new TypeError('invalid_candidate_overlay');
    return this.db.transaction(() => {
      const prior = this.overlayById.get(profileId, vacancyId, candidateId);
      if ((prior?.revision ?? 0) !== expectedRevision) return { kind: 'revision_conflict', currentRevision: prior?.revision ?? 0 };
      const revision = expectedRevision + 1;
      this.upsertOverlay.run(profileId, vacancyId, candidateId, revision, status, comment, excludeFromSearch ? 1 : 0);
      return { kind: 'updated', revision };
    }).immediate();
  }
  searchFeedback(profileId, vacancyId) {
    this.assertScope(profileId, vacancyId);
    const rows = this.feedbackRows.all(profileId, vacancyId);
    return { revision: hash(rows.map(row => [row.resume_id, row.comment, row.exclude_from_search])).slice(0, 24),
      comments: rows.filter(row => typeof row.comment === 'string' && row.comment.trim())
        .map(row => row.comment.trim()),
      excludedResumeIds: rows.filter(row => row.exclude_from_search === 1).map(row => row.resume_id) };
  }
  cachedFeedbackQueries(profileId, vacancyId, baseRevision, feedbackRevision) {
    this.assertScope(profileId, vacancyId);
    if (typeof baseRevision !== 'string' || !baseRevision || !/^[a-f0-9]{24}$/.test(feedbackRevision))
      throw new TypeError('invalid_feedback_query_key');
    const row = this.feedbackQueries.get(profileId, vacancyId, baseRevision, feedbackRevision);
    return row ? JSON.parse(row.queries) : null;
  }
  storeFeedbackQueries(profileId, vacancyId, baseRevision, feedbackRevision, queries) {
    this.assertScope(profileId, vacancyId);
    if (typeof baseRevision !== 'string' || !baseRevision || !/^[a-f0-9]{24}$/.test(feedbackRevision) ||
        !Array.isArray(queries) || queries.length < 1 || queries.length > 15 ||
        queries.some(query => typeof query !== 'string' || !query.trim() || query !== query.trim() || query.length > 500) ||
        new Set(queries).size !== queries.length) throw new TypeError('invalid_feedback_queries');
    return this.db.transaction(() => {
      if (this.searchFeedback(profileId, vacancyId).revision !== feedbackRevision) throw new Error('feedback_revision_stale');
      this.insertFeedbackQueries.run(profileId, vacancyId, baseRevision, feedbackRevision, JSON.stringify(queries));
      return JSON.parse(this.feedbackQueries.get(profileId, vacancyId, baseRevision, feedbackRevision).queries);
    }).immediate();
  }
}
