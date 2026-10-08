import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { REAL_HH_RESULT_VERSION, SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { createAcceptedHhAssessmentReportReader } from '../src/r04-accepted-hh-assessment-reader.js';

const profileId = 'profile_synthetic_owner';
const vacancyId = 'vacancy_synthetic_owned';
const resumeId = 'resumesynthetic001';
const criteriaRevision = 'criteria-synthetic-r1';
const atsConfig = { vacancy_title: 'Synthetic Engineer', filters: { min_experience_years: 0 }, required: [], preferred: [] };
const resumeRaw = { id: resumeId, title: 'Synthetic Platform Engineer', first_name: 'Синтетический', last_name: 'Кандидат',
  total_experience: { months: 60 }, area: { name: 'Тестовый регион' }, salary: null,
  experience: [{ position: 'Инженер', company: 'Тестовая компания', start: '2020', end: null }] };

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'accepted-report-assessment-'));
  const filename = join(directory, 'private.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidateState = new SqliteRealHhCandidateState({ filename,
    isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId });
  t.after(() => { if (candidateState.db.open) candidateState.close(); });
  const scheduled = [];
  const scheduleRepository = { listOccurrences: profile => scheduled.filter(row => row.profileId === profile) };
  const manualRuns = { candidateState, listAcceptedManualReceipts: () => [] };
  const candidateProjection = mapHhResumeCandidate(resumeRaw, atsConfig, vacancyId,
    { bypassMinExperience: true }).candidate;
  const completion = candidateState.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION,
    profileId, vacancyId, jobId: 'job_synthetic_001', source: 'scheduled',
    searchedAt: '2026-10-06T06:00:00.000Z', criteriaRevision,
    sourceRevision: 'snapshot-source-revision', totalCollected: 1, candidates: [candidateProjection] });
  const assessmentInput = candidateState.unassessedLatest({ profileId, vacancyId })[0];
  candidateState.recordAssessment({ profileId, vacancyId, jobId: completion.jobId, candidateId: resumeId,
    inputRevision: assessmentInput.inputRevision,
    assessment: { atsScore: 8.5, atsTag: 'PASS', knockout: { status: 'passed', criteria: [] } },
    assessedAt: '2026-10-06T06:05:00.000Z' });
  scheduled.push({ profileId, vacancyId, scheduledAt: '2026-10-06T06:00:00.000Z', status: 'succeeded',
    jobId: completion.jobId, snapshot: { resultRevision: completion.resultRevision,
      sourceRevision: completion.sourceRevision, resultCount: completion.candidateCount } });
  const reader = createAcceptedHhAssessmentReportReader({ scheduleRepository, candidateState,
    manualRuns, isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId });
  return { reader, candidateState, scheduled, candidateProjection };
}

test('only exact current mapped resume input with accepted snapshot and current criteria returns assessment', t => {
  const f = setup(t);
  const result = f.reader(profileId, vacancyId, resumeId, { criteriaRevision,
    resumeRevision: 'a'.repeat(64), candidateProjection: f.candidateProjection });
  assert.deepEqual(result, { profileId, vacancyId, resumeId, resumeRevision: 'a'.repeat(64),
    criteriaRevision, assessmentRevision: f.candidateState.assessmentForSnapshot({ profileId, vacancyId,
      jobId: 'job_synthetic_001', candidateId: resumeId }).inputRevision,
    atsScore: 8.5, atsTag: 'PASS', reviewStatus: 'active', reviewRevision: 0 });
  assert.equal(f.candidateState.updateCandidateOverlay({ profileId, vacancyId, candidateId: resumeId,
    expectedRevision: 0, status: 'starred', comment: 'private note', excludeFromSearch: false }).kind, 'updated');
  assert.equal(f.reader(profileId, vacancyId, resumeId, { criteriaRevision,
    resumeRevision: 'a'.repeat(64), candidateProjection: f.candidateProjection }).reviewStatus, 'starred');
  assert.equal(f.reader(profileId, vacancyId, resumeId, { criteriaRevision,
    resumeRevision: 'a'.repeat(64), candidateProjection: { ...f.candidateProjection, title: 'Changed resume' } }), null);
  assert.equal(f.reader(profileId, vacancyId, resumeId, { criteriaRevision: 'criteria-stale',
    resumeRevision: 'a'.repeat(64), candidateProjection: f.candidateProjection }), null);
});

test('unknown or archived snapshots cannot supply an accepted report assessment', t => {
  const f = setup(t);
  f.scheduled[0].status = 'outcome_unknown';
  const request = { criteriaRevision, resumeRevision: 'a'.repeat(64), candidateProjection: f.candidateProjection };
  assert.equal(f.reader(profileId, vacancyId, resumeId, request), null);
  f.scheduled[0].status = 'succeeded';
  f.candidateState.updateCandidateOverlay({ profileId, vacancyId, candidateId: resumeId,
    expectedRevision: 0, status: 'archived', comment: null, excludeFromSearch: false });
  assert.equal(f.reader(profileId, vacancyId, resumeId, request), null);
  assert.equal(f.reader('profile_foreign', vacancyId, resumeId, request), null);
});
