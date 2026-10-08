import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { SqliteRealHhCandidateState, REAL_HH_RESULT_VERSION } from '../src/sqlite-real-hh-candidate-state.js';
import { runHhBackgroundScoringTick } from '../src/hh-background-scorer.js';

const profileId = 'profile_synthetic_a';
const vacancyId = 'vacancy_synthetic_a';
const criteriaRevision = 'criteria_synthetic_r1';
const ats = { filters: { min_experience_years: 0 }, required: [{ name: 'вымышленный критерий', weight: 1 }], knockout: [] };
const candidate = n => mapHhResumeCandidate({ id: `syntheticresume${n}`, title: 'Вымышленный инженер', first_name: 'Вымышленное', last_name: 'Имя',
  total_experience: { months: 24 }, area: { name: 'Вымышленный регион' }, salary: null,
  experience: [{ position: 'Вымышленный инженер', company: 'Вымышленная компания', start: '2021-01-01', end: null }] }, ats, vacancyId).candidate;
const search = (jobId, candidates) => ({ version: REAL_HH_RESULT_VERSION, profileId, vacancyId, jobId,
  searchedAt: jobId.endsWith('2') ? '2026-10-06T07:00:00.000Z' : '2026-10-06T06:00:00.000Z',
  criteriaRevision, sourceRevision: 'source_synthetic_r1', source: 'scheduled', totalCollected: candidates.length, candidates });
const assessment = { atsScore: 8, atsTag: 'PASS', knockout: { status: 'passed', criteria: [] } };

test('assessment DTO matches the versioned allowlist', () => {
  const schema = JSON.parse(readFileSync(new URL('../contracts/v1-real-hh-assessment.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(assessment), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...assessment, rawResume: 'synthetic private text' }), false);
  assert.equal(validate({ ...assessment, knockout: { status: 'failed', criteria: ['вымышленный стоп-фактор'] } }), false);
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'hh-scorer-'));
  const filename = join(directory, 'private.sqlite');
  const stores = [];
  t.after(() => { for (const store of stores) if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = () => { const store = new SqliteRealHhCandidateState({ filename, isVacancyOwned: (p, v) => p === profileId && v === vacancyId }); stores.push(store); return store; };
  return { open };
}

test('five-minute pass scores invented latest candidates, keeps source snapshot immutable, survives restart', async t => {
  const { open } = fixture(t);
  const state = open();
  state.recordCompletedSearch(search('job_synthetic_1', [candidate(1), candidate(2)]));
  assert.equal(state.assessmentForLatest({ profileId, vacancyId, jobId: 'job_synthetic_1',
    candidateId: candidate(1).id }).kind, 'pending');
  const original = state.resultPage({ profileId, vacancyId, jobId: 'job_synthetic_1' });
  let calls = 0;
  const options = { state, profileId, vacancyId, evaluate: async () => { calls++; return assessment; }, currentCriteriaRevision: async () => criteriaRevision,
    now: () => new Date('2026-10-06T06:05:00.000Z') };
  assert.deepEqual(await runHhBackgroundScoringTick(options), { pending: 2, written: 2, stale: 0, alreadyScored: 0, failed: 0 });
  assert.equal(state.assessmentForLatest({ profileId, vacancyId, jobId: 'job_synthetic_1',
    candidateId: candidate(1).id }).kind, 'scored');
  assert.equal(calls, 2);
  assert.deepEqual(state.resultPage({ profileId, vacancyId, jobId: 'job_synthetic_1' }), original);
  assert.deepEqual(state.assessedResultPage({ profileId, vacancyId, jobId: 'job_synthetic_1' }).items.map(item => item.atsScore), [8, 8]);
  state.close();
  const reopened = open();
  assert.equal(reopened.unassessedLatest({ profileId, vacancyId }).length, 0);
  assert.equal(reopened.assessedResultPage({ profileId, vacancyId, jobId: 'job_synthetic_1' }).items[0].atsTag, 'PASS');
  assert.equal((await runHhBackgroundScoringTick({ ...options, state: reopened })).pending, 0);
  assert.equal(calls, 2);
  reopened.recordCompletedSearch(search('job_synthetic_2', [candidate(1), { ...candidate(2), title: 'Вымышленный старший инженер' }]));
  assert.equal(reopened.assessmentForLatest({ profileId, vacancyId, jobId: 'job_synthetic_1',
    candidateId: candidate(1).id }).kind, 'stale');
  assert.deepEqual(reopened.unassessedLatest({ profileId, vacancyId }).map(item => item.candidate.id), [candidate(2).id]);
  assert.deepEqual(reopened.assessedResultPage({ profileId, vacancyId, jobId: 'job_synthetic_2' }).items.map(item => item.atsScore).sort(), [8, null].sort());
  assert.equal((await runHhBackgroundScoringTick({ ...options, state: reopened })).written, 1);
  assert.equal(calls, 3);
});

test('late evaluator cannot score a superseded search or changed criteria', async t => {
  const { open } = fixture(t);
  const state = open();
  state.recordCompletedSearch(search('job_synthetic_1', [candidate(1)]));
  const result = await runHhBackgroundScoringTick({ state, profileId, vacancyId, currentCriteriaRevision: async () => criteriaRevision,
    evaluate: async () => { state.recordCompletedSearch(search('job_synthetic_2', [candidate(1)])); return assessment; } });
  assert.equal(result.stale, 1);
  assert.equal(state.assessedResultPage({ profileId, vacancyId, jobId: 'job_synthetic_1' }).items[0].atsScore, null);
  assert.equal(state.unassessedLatest({ profileId, vacancyId }).length, 1);
  let revision = criteriaRevision;
  const changed = await runHhBackgroundScoringTick({ state, profileId, vacancyId,
    currentCriteriaRevision: async () => revision, evaluate: async () => { revision = 'criteria_synthetic_r2'; return assessment; } });
  assert.equal(changed.stale, 1);
  assert.equal(state.unassessedLatest({ profileId, vacancyId }).length, 1);
});

test('two writers converge, reject cross-scope and invalid assessments, and hide evaluator errors', async t => {
  const { open } = fixture(t);
  const a = open(); const b = open();
  a.recordCompletedSearch(search('job_synthetic_1', [candidate(1)]));
  const pending = a.unassessedLatest({ profileId, vacancyId });
  const input = { profileId, vacancyId, jobId: pending[0].snapshot.jobId, candidateId: pending[0].candidate.id,
    inputRevision: pending[0].inputRevision, assessment, assessedAt: '2026-10-06T06:05:00.000Z' };
  assert.deepEqual(a.recordAssessment(input), { kind: 'written' });
  assert.deepEqual(b.recordAssessment(input), { kind: 'already_scored' });
  assert.throws(() => b.recordAssessment({ ...input, profileId: 'profile_synthetic_other' }), /real_hh_scope_denied/);
  assert.throws(() => b.recordAssessment({ ...input, assessment: { ...assessment, atsScore: 11 } }), /invalid_real_hh_assessment/);
  assert.throws(() => b.recordAssessment({ ...input, assessment: { ...assessment, knockout: { status: 'failed', criteria: ['вымышленный стоп-фактор'] } } }), /invalid_real_hh_assessment/);
  a.recordCompletedSearch(search('job_synthetic_2', [candidate(1), candidate(2)]));
  const summary = await runHhBackgroundScoringTick({ state: b, profileId, vacancyId,
    currentCriteriaRevision: async () => criteriaRevision, evaluate: async () => { throw new Error('synthetic private resume in error'); },
    now: () => new Date('2026-10-06T06:10:00.000Z') });
  assert.equal(summary.failed, 1);
  assert.equal(JSON.stringify(summary).includes('resume'), false);
  const invalid = await runHhBackgroundScoringTick({ state: b, profileId, vacancyId,
    currentCriteriaRevision: async () => criteriaRevision, evaluate: async () => ({ ...assessment, atsScore: 11 }),
    now: () => new Date('2026-10-06T06:30:00.000Z') });
  assert.equal(invalid.failed, 1);
  assert.equal(b.unassessedLatest({ profileId, vacancyId, at: '2026-10-06T06:31:00.000Z' }).length, 0);
});

test('failed assessment backs off durably and does not starve later candidates', async t => {
  const { open } = fixture(t);
  const state = open();
  state.recordCompletedSearch(search('job_synthetic_1', [candidate(1), candidate(2)]));
  let calls = [];
  const run = (at) => runHhBackgroundScoringTick({ state, profileId, vacancyId, limit: 1,
    currentCriteriaRevision: async () => criteriaRevision,
    evaluate: async ({ candidate: item }) => {
      calls.push(item.id);
      if (item.id === candidate(1).id && calls.filter(id => id === item.id).length < 3)
        throw new Error('invented private prompt');
      return assessment;
    }, now: () => new Date(at) });
  assert.equal((await run('2026-10-06T06:05:00.000Z')).failed, 1);
  assert.equal((await run('2026-10-06T06:10:00.000Z')).written, 1);
  assert.deepEqual(calls, [candidate(1).id, candidate(2).id]);
  state.close();
  const reopened = open();
  assert.equal(reopened.unassessedLatest({ profileId, vacancyId, at: '2026-10-06T06:19:59.000Z' }).length, 0);
  assert.equal(reopened.unassessedLatest({ profileId, vacancyId, at: '2026-10-06T06:20:00.000Z' }).length, 1);
  assert.equal((await runHhBackgroundScoringTick({ state: reopened, profileId, vacancyId,
    currentCriteriaRevision: async () => criteriaRevision,
    evaluate: async () => { throw new Error('invented private resume'); },
    now: () => new Date('2026-10-06T06:20:00.000Z') })).failed, 1);
  assert.equal(reopened.unassessedLatest({ profileId, vacancyId, at: '2026-10-06T06:49:59.000Z' }).length, 0);
  assert.equal(reopened.unassessedLatest({ profileId, vacancyId, at: '2026-10-06T06:50:00.000Z' }).length, 1);
  const recovered = await runHhBackgroundScoringTick({ state: reopened, profileId, vacancyId,
    currentCriteriaRevision: async () => criteriaRevision, evaluate: async () => assessment,
    now: () => new Date('2026-10-06T06:50:00.000Z') });
  assert.equal(recovered.written, 1);
  assert.equal(reopened.unassessedLatest({ profileId, vacancyId }).length, 0);
});
