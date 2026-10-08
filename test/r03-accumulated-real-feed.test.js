import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { REAL_HH_RESULT_VERSION, SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { createR03AccumulatedRealFeed } from '../src/r03-accumulated-real-feed.js';

const profileA = 'profile_synthetic_a';
const profileB = 'profile_synthetic_b';
const vacancyA = 'vacancy_synthetic_a';
const vacancyB = 'vacancy_synthetic_b';
const context = profileId => ({ profileId, scopes: ['recruiting.candidateSearch'] });
const ats = { filters: { min_experience_years: 0 }, required: [{ name: 'вымышленный критерий', weight: 1 }], knockout: [] };
const candidate = (n, vacancyId, title = 'Вымышленный инженер') => mapHhResumeCandidate({
  id: `syntheticresume${n}`, title, first_name: 'Вымышленное', last_name: 'Имя', total_experience: { months: 24 },
  area: { name: 'Вымышленный регион' }, salary: null,
  experience: [{ position: title, company: 'Вымышленная компания', start: '2021-01-01', end: null }]
}, ats, vacancyId).candidate;
const search = ({ profileId = profileA, vacancyId = vacancyA, jobId, source = 'scheduled', searchedAt, candidates }) => ({
  version: REAL_HH_RESULT_VERSION, profileId, vacancyId, jobId, source, searchedAt,
  criteriaRevision: 'criteria_synthetic_r1', sourceRevision: 'source_synthetic_r1', totalCollected: candidates.length, candidates
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'real-hh-feed-'));
  const filename = join(directory, 'private.sqlite');
  const stores = [];
  t.after(() => { for (const store of stores) if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = () => { const state = new SqliteRealHhCandidateState({ filename,
    isVacancyOwned: (p, v) => [profileA, profileB].includes(p) && [vacancyA, vacancyB].includes(v) }); stores.push(state); return state; };
  const occurrences = [];
  const manualReceipts = [];
  const scheduleRepository = { listOccurrences: profileId => occurrences.filter(row => row.profileId === profileId) };
  const loadAcceptedManualReceipts = (profileId, vacancyId) => manualReceipts.filter(row => row.profileId === profileId && row.vacancyId === vacancyId);
  return { open, occurrences, manualReceipts, scheduleRepository, loadAcceptedManualReceipts };
}
const receipt = snapshot => ({ profileId: snapshot.profileId, vacancyId: snapshot.vacancyId, jobId: snapshot.jobId,
  status: 'succeeded', resultRevision: snapshot.resultRevision, sourceRevision: snapshot.sourceRevision,
  resultCount: snapshot.candidateCount });

test('feed accumulates accepted scheduled and manual candidates across two vacancies and profiles with score/review overlays', t => {
  const f = fixture(t);
  const state = f.open();
  const first = state.recordCompletedSearch(search({ jobId: 'job_synthetic_1', searchedAt: '2026-10-06T06:00:00.000Z',
    candidates: [candidate(1, vacancyA), candidate(2, vacancyA)] }));
  const toScore = state.unassessedLatest({ profileId: profileA, vacancyId: vacancyA })[0];
  assert.equal(state.recordAssessment({ profileId: profileA, vacancyId: vacancyA, jobId: first.jobId,
    candidateId: toScore.candidate.id, inputRevision: toScore.inputRevision,
    assessment: { atsScore: 9, atsTag: 'PASS', knockout: { status: 'passed', criteria: [] } },
    assessedAt: '2026-10-06T06:05:00.000Z' }).kind, 'written');
  f.occurrences.push({ profileId: profileA, vacancyId: vacancyA, scheduledAt: '2026-10-06T06:00:00.000Z', status: 'succeeded',
    jobId: first.jobId, snapshot: { resultRevision: first.resultRevision, sourceRevision: first.sourceRevision, resultCount: first.candidateCount } });
  const manualA = state.recordCompletedSearch(search({ jobId: 'job_synthetic_2', source: 'manual', searchedAt: '2026-10-06T07:00:00.000Z',
    candidates: [candidate(2, vacancyA, 'Вымышленный старший инженер'), candidate(3, vacancyA)] }));
  const manualB = state.recordCompletedSearch(search({ profileId: profileA, vacancyId: vacancyB, jobId: 'job_synthetic_3', source: 'manual',
    searchedAt: '2026-10-06T08:00:00.000Z', candidates: [candidate(1, vacancyB)] }));
  const manualC = state.recordCompletedSearch(search({ profileId: profileB, vacancyId: vacancyA, jobId: 'job_synthetic_4', source: 'manual',
    searchedAt: '2026-10-06T09:00:00.000Z', candidates: [candidate(1, vacancyA)] }));
  f.manualReceipts.push(receipt(manualA), receipt(manualB), receipt(manualC));
  const feed = createR03AccumulatedRealFeed({ scheduleRepository: f.scheduleRepository, candidateState: state,
    loadAcceptedManualReceipts: f.loadAcceptedManualReceipts });
  const items = feed.read(context(profileA), vacancyA).items;
  assert.equal(items.length, 3);
  assert.equal(feed.read(context(profileA), vacancyA).assessmentStatus, 'assessment_pending');
  assert.equal(feed.read(context(profileA), vacancyA).assessmentPendingCount, 2);
  assert.equal(items[0].id, toScore.candidate.id, 'assessed candidates rank ahead of pending ATS evaluations');
  assert.equal(items.find(item => item.id === toScore.candidate.id).atsScore, 9);
  assert.equal(items.find(item => item.id === candidate(2, vacancyA).id).title, 'Вымышленный старший инженер');
  assert.equal(feed.read(context(profileA), vacancyB).total, 1);
  assert.equal(feed.read(context(profileB), vacancyA).total, 1);
  assert.equal(feed.update(context(profileA), vacancyA, candidate(1, vacancyA).id, {
    expectedRevision: 0, status: 'starred', comment: 'Синтетическая заметка', excludeFromSearch: true }).revision, 1);
  assert.equal(feed.read(context(profileA), vacancyA).items.find(item => item.id === candidate(1, vacancyA).id).review.status, 'starred');
  assert.equal(feed.read(context(profileA), vacancyB).items[0].review.status, 'active');
  assert.equal(feed.read(context(profileB), vacancyA).items[0].comment, null);
  assert.deepEqual(feed.update(context(profileA), vacancyA, candidate(1, vacancyA).id, {
    expectedRevision: 0, status: 'archived', comment: null, excludeFromSearch: false }), { kind: 'revision_conflict', currentRevision: 1 });
  assert.throws(() => feed.update({ profileId: profileB, scopes: [] }, vacancyA, candidate(1, vacancyA).id, {}), /candidate_scope_denied/);
  state.close();
  const reopened = f.open();
  assert.equal(createR03AccumulatedRealFeed({ scheduleRepository: f.scheduleRepository, candidateState: reopened,
    loadAcceptedManualReceipts: f.loadAcceptedManualReceipts })
    .read(context(profileA), vacancyA).items.find(item => item.id === candidate(1, vacancyA).id).comment, 'Синтетическая заметка');
});

test('unknown scheduled snapshot is quarantined from feed, older accepted result stays stale, and unbound candidate is rejected', t => {
  const f = fixture(t);
  const state = f.open();
  const first = state.recordCompletedSearch(search({ jobId: 'job_synthetic_1', searchedAt: '2026-10-06T06:00:00.000Z', candidates: [candidate(1, vacancyA)] }));
  f.occurrences.push({ profileId: profileA, vacancyId: vacancyA, scheduledAt: '2026-10-06T06:00:00.000Z', status: 'succeeded',
    jobId: first.jobId, snapshot: { resultRevision: first.resultRevision, sourceRevision: first.sourceRevision, resultCount: first.candidateCount } });
  state.recordCompletedSearch(search({ jobId: 'job_synthetic_2', searchedAt: '2026-10-07T06:00:00.000Z', candidates: [candidate(2, vacancyA)] }));
  f.occurrences.push({ profileId: profileA, vacancyId: vacancyA, scheduledAt: '2026-10-07T06:00:00.000Z', status: 'outcome_unknown',
    jobId: 'job_synthetic_2', snapshot: null });
  const feed = createR03AccumulatedRealFeed({ scheduleRepository: f.scheduleRepository, candidateState: state });
  const morning = feed.read(context(profileA), vacancyA);
  assert.equal(morning.freshness, 'latest_run_incomplete');
  assert.deepEqual(morning.items.map(item => item.id), [candidate(1, vacancyA).id]);
  assert.throws(() => feed.update(context(profileA), vacancyA, candidate(2, vacancyA).id, {
    expectedRevision: 0, status: 'starred', comment: null, excludeFromSearch: false }), /candidate_not_in_accepted_vacancy_feed/);
  assert.throws(() => state.recordCompletedSearch(search({ jobId: 'job_synthetic_3', searchedAt: '2026-10-08T06:00:00.000Z',
    candidates: [candidate(3, vacancyB)] })), /invalid_real_hh_candidate/, 'legacy candidate without this vacancy binding must be quarantined');
});

test('committed manual snapshot stays hidden until a matching durable completion receipt exists', t => {
  const f = fixture(t);
  const state = f.open();
  const completed = state.recordCompletedSearch(search({ jobId: 'job_synthetic_manual', source: 'manual',
    searchedAt: '2026-10-06T06:00:00.000Z', candidates: [candidate(1, vacancyA)] }));
  const feed = createR03AccumulatedRealFeed({ scheduleRepository: f.scheduleRepository, candidateState: state,
    loadAcceptedManualReceipts: f.loadAcceptedManualReceipts });
  assert.equal(feed.read(context(profileA), vacancyA).total, 0, 'snapshot commit is not a manual completion receipt');
  f.manualReceipts.push({ ...receipt(completed), status: 'outcome_unknown' });
  assert.equal(feed.read(context(profileA), vacancyA).total, 0);
  f.manualReceipts[0] = { ...receipt(completed), resultRevision: 'wrong_revision' };
  assert.equal(feed.read(context(profileA), vacancyA).total, 0);
  f.manualReceipts[0] = receipt(completed);
  assert.equal(feed.read(context(profileA), vacancyA).total, 1);
});
