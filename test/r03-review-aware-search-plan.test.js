import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { SqliteRealHhCandidateState, REAL_HH_RESULT_VERSION } from '../src/sqlite-real-hh-candidate-state.js';
import { createReviewAwareSearchPlan } from '../src/r03-review-aware-search-plan.js';
import { createOfflineHhColdSearch } from '../src/hh-cold-search-offline.js';

const profileId = 'profile_synthetic_001';
const vacancyA = 'vacancy_synthetic_001';
const vacancyB = 'vacancy_synthetic_002';
const atsConfig = { filters: { min_experience_years: 0 }, required: [{ name: 'вымышленный инженер', weight: 2 }], knockout: [] };
const raw = n => ({ id: `syntheticresume${n}`, title: 'Вымышленный инженер', first_name: 'Вымышленное', last_name: 'Имя',
  area: { name: 'Вымышленный регион' }, total_experience: { months: 24 },
  experience: [{ position: 'вымышленный инженер', company: 'Вымышленная компания', start: '2021-01-01', end: null }] });
const mapped = (n, vacancyId = vacancyA) => mapHhResumeCandidate(raw(n), atsConfig, vacancyId).candidate;
const basePlan = vacancyId => ({ profileId, vacancyId, criteriaRevision: 'criteria_synthetic_r1',
  queryCache: { revision: 'query_synthetic_r1', queries: ['вымышленный инженер'] }, atsConfig, area: null });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'r03-feedback-'));
  const filename = join(directory, 'private.sqlite');
  const stores = [];
  t.after(() => { for (const store of stores) if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = () => { const state = new SqliteRealHhCandidateState({ filename,
    isVacancyOwned: (profile, vacancy) => profile === profileId && [vacancyA, vacancyB].includes(vacancy) }); stores.push(state); return state; };
  return { open };
}
function seed(state) {
  state.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION, profileId, vacancyId: vacancyA,
    jobId: 'job_synthetic_seed', searchedAt: '2026-10-06T05:00:00.000Z', criteriaRevision: 'criteria_synthetic_r1',
    sourceRevision: 'source_synthetic_seed', source: 'manual', totalCollected: 2,
    candidates: [mapped(1), mapped(2)] });
}

test('comment regenerates one durable vacancy query set; exclusion filters result and survives restart', async t => {
  const { open } = fixture(t);
  const state = open();
  seed(state);
  assert.equal(state.updateCandidateOverlay({ profileId, vacancyId: vacancyA, candidateId: mapped(1).id,
    expectedRevision: 0, status: 'archived', comment: 'Не подходит вымышленный регион', excludeFromSearch: true }).kind, 'updated');
  let generations = 0;
  const generateQueries = async ({ comments }) => { generations++; assert.deepEqual(comments, ['Не подходит вымышленный регион']);
    return ['вымышленный инженер без региона']; };
  const loadSearchPlan = createReviewAwareSearchPlan({ loadBasePlan: async (_, vacancyId) => basePlan(vacancyId),
    candidateState: state, generateQueries });
  const plan = await loadSearchPlan(profileId, vacancyA);
  assert.equal(generations, 1);
  assert.deepEqual(plan.excludedResumeIds, [mapped(1).id]);
  assert.deepEqual(plan.queryCache.queries, ['вымышленный инженер без региона']);
  state.updateCandidateOverlay({ profileId, vacancyId: vacancyA, candidateId: mapped(1).id,
    expectedRevision: 1, status: 'starred', comment: 'Не подходит вымышленный регион', excludeFromSearch: true });
  assert.equal((await loadSearchPlan(profileId, vacancyA)).queryCache.revision, plan.queryCache.revision,
    'display-only status does not regenerate search queries');
  const search = createOfflineHhColdSearch({ loadSearchPlan, candidateState: state,
    transport: { search: async () => ({ profileId, vacancyId: vacancyA, areas: [], items: [raw(1), raw(3)] }) },
    clock: () => new Date('2026-10-06T06:00:00.000Z') });
  const result = await search.run({ trustedContext: { profileId, scopes: ['recruiting.candidateSearch'] },
    vacancyId: vacancyA, jobId: 'job_synthetic_feedback', source: 'scheduled',
    expectedCriteriaRevision: plan.criteriaRevision, expectedQueryRevision: plan.queryCache.revision });
  assert.equal(result.snapshot.candidateCount, 1);
  assert.equal(result.snapshot.totalCollected, 2);
  assert.equal(state.resultPage({ profileId, vacancyId: vacancyA, jobId: 'job_synthetic_feedback' }).items[0].id, mapped(3).id);
  assert.equal(generations, 1, 'post-provider plan check reuses durable generated queries');
  const other = await loadSearchPlan(profileId, vacancyB);
  assert.equal(other.queryCache.revision, 'query_synthetic_r1');
  assert.deepEqual(other.excludedResumeIds, []);
  state.close();
  const reopened = open();
  const afterRestart = createReviewAwareSearchPlan({ loadBasePlan: async (_, vacancyId) => basePlan(vacancyId),
    candidateState: reopened, generateQueries });
  assert.deepEqual((await afterRestart(profileId, vacancyA)).queryCache.queries, plan.queryCache.queries);
  assert.equal(generations, 1);
});

test('changing feedback during HH collection fails before snapshot; pinned manual query stays pinned', async t => {
  const { open } = fixture(t);
  const state = open();
  seed(state);
  state.updateCandidateOverlay({ profileId, vacancyId: vacancyA, candidateId: mapped(1).id,
    expectedRevision: 0, status: 'active', comment: 'Не подходит вымышленный регион', excludeFromSearch: false });
  let generations = 0;
  const generateQueries = async () => { generations++; return [`вымышленный запрос ${generations}`]; };
  const loadSearchPlan = createReviewAwareSearchPlan({ loadBasePlan: async (_, vacancyId) => basePlan(vacancyId),
    candidateState: state, generateQueries });
  const plan = await loadSearchPlan(profileId, vacancyA);
  const search = createOfflineHhColdSearch({ loadSearchPlan, candidateState: state,
    transport: { search: async () => {
      state.updateCandidateOverlay({ profileId, vacancyId: vacancyA, candidateId: mapped(1).id,
        expectedRevision: 1, status: 'active', comment: 'Не подходит другая вымышленная область', excludeFromSearch: false });
      return { profileId, vacancyId: vacancyA, areas: [], items: [raw(3)] };
    } } });
  await assert.rejects(search.run({ trustedContext: { profileId, scopes: ['recruiting.candidateSearch'] },
    vacancyId: vacancyA, jobId: 'job_synthetic_stale', source: 'manual',
    expectedCriteriaRevision: plan.criteriaRevision, expectedQueryRevision: plan.queryCache.revision }), /search_plan_stale/);
  assert.equal(state.resultPage({ profileId, vacancyId: vacancyA, jobId: 'job_synthetic_stale' }), null);
  const pinned = createReviewAwareSearchPlan({ loadBasePlan: async () => ({ ...basePlan(vacancyA),
    queryCache: { ...basePlan(vacancyA).queryCache, manual: true } }), candidateState: state,
    generateQueries: async () => { throw new Error('manual query must stay pinned'); } });
  assert.deepEqual((await pinned(profileId, vacancyA)).queryCache.queries, ['вымышленный инженер']);
});
