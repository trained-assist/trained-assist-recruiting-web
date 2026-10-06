import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { REAL_HH_RESULT_VERSION, SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { SqliteAcceptedAssessmentQueue } from '../src/sqlite-accepted-assessment-queue.js';
import { createR03AccumulatedRealFeed } from '../src/r03-accumulated-real-feed.js';
import { runAcceptedAssessmentWorker } from '../src/r03-accepted-assessment-worker.js';

const profileId = 'invented_profile'; const otherProfile = 'other_profile';
const vacancyId = 'invented_vacancy';
const ats = { filters: { min_experience_years: 0 }, required: [{ name: 'инженер', weight: 1 }] };
const candidate = (id) => mapHhResumeCandidate({ id, title: 'Вымышленный инженер',
  first_name: 'Вымышленное', last_name: 'Имя', area: { name: 'Вымышленная область' },
  total_experience: { months: 48 }, experience: [] }, ats, vacancyId).candidate;
const receipt = snapshot => ({ profileId: snapshot.profileId, vacancyId: snapshot.vacancyId,
  jobId: snapshot.jobId, scheduledAt: snapshot.searchedAt, status: 'succeeded',
  snapshot: { sourceRevision: snapshot.sourceRevision,
    resultRevision: snapshot.resultRevision, resultCount: snapshot.candidateCount } });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'r03-accepted-assessment-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = join(root, 'private.sqlite');
  const state = new SqliteRealHhCandidateState({ filename,
    isVacancyOwned: (p, v) => [profileId, otherProfile].includes(p) && v === vacancyId });
  t.after(() => state.close());
  let now = '2026-10-07T09:00:00.000Z';
  const accepted = [];
  const scheduleRepository = { listOccurrences: p => accepted.filter(row => row.profileId === p) };
  const opened = [];
  const open = (evaluate = async () => ({ atsScore: 8, atsTag: 'PASS',
    knockout: { status: 'passed', criteria: [] } })) => {
    const queue = new SqliteAcceptedAssessmentQueue({ filename, candidateState: state,
      scheduleRepository, evaluate, currentCriteriaRevision: async () => 'criteria_invented_r1',
      clock: () => new Date(now), leaseMs: 60_000 });
    opened.push(queue);
    return queue;
  };
  t.after(() => opened.forEach(queue => { if (queue.db.open) queue.close(); }));
  const add = (p, jobId, searchedAt, id, accept = true, preScore = null) => {
    const projected = candidate(id);
    if (preScore !== null) projected.preScore = preScore;
    const snapshot = state.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION,
      profileId: p, vacancyId, jobId, source: 'scheduled', searchedAt,
      criteriaRevision: 'criteria_invented_r1', sourceRevision: 'source_invented_r1',
      totalCollected: 1, candidates: [projected] });
    if (accept) accepted.push(receipt(snapshot));
    return snapshot;
  };
  return { filename, state, accepted, scheduleRepository, open, add,
    setNow: value => { now = value; } };
}

test('accepted older snapshot drains after newer snapshot, survives restart, excludes unknown and cross-profile', async t => {
  const f = fixture(t);
  f.add(profileId, 'old_job', '2026-10-06T06:00:00.000Z', 'inventedold');
  f.add(profileId, 'new_job', '2026-10-07T06:00:00.000Z', 'inventednew');
  f.add(profileId, 'unknown_job', '2026-10-07T07:00:00.000Z', 'inventedunknown', false);
  f.add(otherProfile, 'foreign_job', '2026-10-07T06:30:00.000Z', 'inventedforeign');
  const queue = f.open();
  const first = await queue.tick(profileId, vacancyId, 'worker_a', 1);
  assert.equal(first.acceptedJobs, 2);
  assert.equal(first.inserted, 2);
  assert.equal(first.written, 1);
  assert.equal(f.state.assessedResultPage({ profileId, vacancyId, jobId: 'old_job', limit: 1 }).items[0].atsScore, 8);
  assert.equal(f.state.assessedResultPage({ profileId, vacancyId, jobId: 'new_job', limit: 1 }).items[0].atsScore, null);
  queue.close();
  const reopened = f.open();
  assert.equal((await reopened.tick(profileId, vacancyId, 'worker_b', 1)).written, 1);
  assert.equal((await reopened.tick(profileId, vacancyId, 'worker_c', 1)).claimed, 0);
  assert.equal(f.state.assessedResultPage({ profileId, vacancyId, jobId: 'new_job', limit: 1 }).items[0].atsScore, 8);
  assert.equal(f.state.assessedResultPage({ profileId, vacancyId, jobId: 'unknown_job', limit: 1 }).items[0].atsScore, null);
  assert.equal(f.state.assessedResultPage({ profileId: otherProfile, vacancyId, jobId: 'foreign_job', limit: 1 }).items[0].atsScore, null);
  const feed = createR03AccumulatedRealFeed({ scheduleRepository: f.scheduleRepository,
    candidateState: f.state, assessmentQueue: reopened });
  assert.equal(feed.read({ profileId, scopes: ['recruiting.candidateSearch'] }, vacancyId).assessmentStatus, 'assessed');
  assert.throws(() => reopened.statusFor('unowned_profile', vacancyId, 'old_job', 'inventedold'), /real_hh_scope_denied/);
});

test('claim reserves old backlog and prioritizes fresh high pre-score candidates', t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) f.add(profileId, `job${i}`,
    new Date(Date.parse('2026-10-06T06:00:00.000Z') + i * 60_000).toISOString(),
    `resume${i}`, true, i === 7 ? 9 : i === 6 ? 8 : 1);
  const queue = f.open();
  assert.equal(queue.sync(profileId, vacancyId).inserted, 8);
  const claimed = queue.claim(profileId, vacancyId, 'worker_a', 6);
  assert.deepEqual(claimed.map(row => row.job_id),
    ['job0', 'job1', 'job7', 'job6', 'job5', 'job4']);
});

test('expired lease is unknown without an automatic second model call', async t => {
  const f = fixture(t);
  f.add(profileId, 'accepted_job', '2026-10-06T06:00:00.000Z', 'inventedresume');
  let calls = 0;
  const queue = f.open(async () => { calls++; throw new Error('must not run'); });
  assert.equal(queue.sync(profileId, vacancyId).inserted, 1);
  const claimed = queue.claim(profileId, vacancyId, 'worker_a', 1);
  assert.equal(claimed.length, 1);
  assert.equal(queue.claim(profileId, vacancyId, 'worker_b', 1).length, 0);
  f.setNow('2026-10-07T09:02:00.000Z');
  assert.equal(queue.claim(profileId, vacancyId, 'worker_b', 1).length, 0);
  assert.equal(queue.statusFor(profileId, vacancyId, 'accepted_job', 'inventedresume'), 'outcome_unknown');
  assert.equal(queue.finish(claimed[0], 'worker_a', 'completed', { atsScore: 8,
    atsTag: 'PASS', knockout: { status: 'passed', criteria: [] } }), false);
  assert.equal((await queue.tick(profileId, vacancyId, 'worker_b', 1)).claimed, 0);
  assert.equal(calls, 0);
  const feed = createR03AccumulatedRealFeed({ scheduleRepository: f.scheduleRepository,
    candidateState: f.state, assessmentQueue: queue });
  const read = feed.read({ profileId, scopes: ['recruiting.candidateSearch'] }, vacancyId);
  assert.equal(read.assessmentStatus, 'assessment_attention');
  assert.equal(read.assessmentPendingCount, 0);
  assert.equal(read.assessmentBlockedCount, 1);
});

test('stale criteria and uncertain evaluator failure become attention without model redispatch', async t => {
  const f = fixture(t);
  f.add(profileId, 'old_criteria_job', '2026-10-06T06:00:00.000Z', 'inventedstale');
  const stale = new SqliteAcceptedAssessmentQueue({ filename: f.filename,
    candidateState: f.state, scheduleRepository: f.scheduleRepository,
    evaluate: async () => { throw new Error('must not evaluate stale'); },
    currentCriteriaRevision: async () => 'criteria_changed',
    clock: () => new Date('2026-10-07T09:00:00.000Z') });
  t.after(() => stale.close());
  assert.equal((await stale.tick(profileId, vacancyId, 'worker_a', 1)).blocked, 1);
  assert.equal(stale.statusFor(profileId, vacancyId, 'old_criteria_job', 'inventedstale'), 'blocked_criteria_stale');
  const feed = createR03AccumulatedRealFeed({ scheduleRepository: f.scheduleRepository,
    candidateState: f.state, assessmentQueue: stale });
  assert.equal(feed.read({ profileId, scopes: ['recruiting.candidateSearch'] }, vacancyId).assessmentStatus,
    'assessment_attention');

  f.add(profileId, 'new_criteria_job', '2026-10-07T07:00:00.000Z', 'inventederror');
  let now = '2026-10-07T09:00:00.000Z';
  let calls = 0;
  const failing = new SqliteAcceptedAssessmentQueue({ filename: f.filename,
    candidateState: f.state, scheduleRepository: f.scheduleRepository,
    evaluate: async () => { calls++; throw new Error('invented model failure'); },
    currentCriteriaRevision: async () => 'criteria_invented_r1',
    clock: () => new Date(now) });
  t.after(() => failing.close());
  assert.equal((await failing.tick(profileId, vacancyId, 'worker_b', 1)).unknown, 1);
  now = '2026-10-07T09:16:00.000Z';
  assert.equal((await failing.tick(profileId, vacancyId, 'worker_b', 1)).claimed, 0);
  assert.equal(calls, 1);
  assert.equal(failing.statusFor(profileId, vacancyId, 'new_criteria_job', 'inventederror'), 'outcome_unknown');
  assert.equal((await failing.tick(profileId, vacancyId, 'worker_b', 1)).claimed, 0);
});

test('five-minute host budget is shared across scopes and restart; later window drains backlog', async t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) f.add(profileId, `job_${i}`, '2026-10-07T06:00:00.000Z', `resume${i}`);
  f.add(otherProfile, 'foreign_job', '2026-10-07T06:00:00.000Z', 'foreignresume');
  let calls = 0;
  const first = f.open(async () => { calls++; return { atsScore: 8, atsTag: 'PASS',
    knockout: { status: 'passed', criteria: [] } }; });
  const scopes = [{ profileId, vacancyId }, { profileId: otherProfile, vacancyId }];
  const one = await runAcceptedAssessmentWorker({ queue: first, scopes, workerId: 'worker_a',
    clock: () => new Date('2026-10-07T09:00:00.000Z') });
  assert.equal(one.written, 6);
  assert.equal(one.budgetRemaining, 0);
  assert.equal(calls, 6);
  first.close();
  const restarted = f.open(async () => { calls++; return { atsScore: 8, atsTag: 'PASS',
    knockout: { status: 'passed', criteria: [] } }; });
  assert.equal((await runAcceptedAssessmentWorker({ queue: restarted, scopes,
    workerId: 'worker_b', clock: () => new Date('2026-10-07T09:00:00.000Z') })).claimed, 0);
  assert.equal(calls, 6);
  f.setNow('2026-10-07T09:05:00.000Z');
  const later = await runAcceptedAssessmentWorker({ queue: restarted, scopes,
    workerId: 'worker_b', clock: () => new Date('2026-10-07T09:05:00.000Z') });
  assert.equal(later.written, 2);
  assert.equal(calls, 8);
  assert.equal(f.state.assessedResultPage({ profileId: otherProfile, vacancyId,
    jobId: 'foreign_job', limit: 1 }).items[0].atsScore, 8);
});
