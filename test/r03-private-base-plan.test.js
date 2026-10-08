import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateBaseSearchPlan, legacyQueryConfigHash } from '../src/r03-private-base-plan.js';
import { createReviewAwareSearchPlan } from '../src/r03-review-aware-search-plan.js';
import { createOfflineHhColdSearch } from '../src/hh-cold-search-offline.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';

const profileId = 'profile_synthetic_001';
const vacancyId = 'vacancy_synthetic_001';
const config = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
  vacancy_context: 'Вымышленная фабрика', filters: { area: { id: '1', name: 'Вымышленный регион' },
    min_experience_years: 0 }, required: [{ name: 'инженер-конструктор', weight: 2 }], knockout: [] };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'r03-private-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contextDirectory = join(root, 'contexts');
  const proactiveDirectory = join(root, 'proactive');
  mkdirSync(contextDirectory, { mode: 0o700 }); mkdirSync(proactiveDirectory, { mode: 0o700 });
  const writeContext = (name, value) => writeFileSync(join(contextDirectory, name), JSON.stringify(value));
  const writeProactive = (name, value) => writeFileSync(join(proactiveDirectory, name), JSON.stringify(value));
  writeContext(`ats_config:${vacancyId}.json`, { value: JSON.stringify(config) });
  writeProactive(`queries-${vacancyId}.json`, { vacancy_id: vacancyId,
    queries: ['вымышленный инженер'], config_hash: legacyQueryConfigHash(config), generated_at: '2026-10-06T00:00:00.000Z' });
  const load = createPrivateBaseSearchPlan({ resolveProfileBinding: async profile => ({ profileId: profile,
    contextDirectory, proactiveDirectory }), isVacancyOwned: (profile, vacancy) =>
    profile === profileId && vacancy === vacancyId });
  return { root, contextDirectory, proactiveDirectory, writeContext, writeProactive, load };
}

test('private profile/ATS/query/area binding yields stable plan for the shared HH handler', async t => {
  const f = fixture(t);
  const plan = await f.load(profileId, vacancyId);
  assert.equal(plan.profileId, profileId);
  assert.equal(plan.vacancyId, vacancyId);
  assert.deepEqual(plan.area, config.filters.area);
  assert.deepEqual(plan.queryCache.queries, ['вымышленный инженер']);
  assert.match(plan.criteriaRevision, /^criteria-[a-f0-9]{24}$/);
  assert.deepEqual(await f.load(profileId, vacancyId), plan);
  await assert.rejects(f.load('profile_synthetic_002', vacancyId), /private_search_plan_unavailable/);
  await assert.rejects(f.load(profileId, 'vacancy_synthetic_002'), /private_search_plan_unavailable/);
});

test('generated cache staleness, missing area and cross-vacancy ATS fail before HH dispatch', async t => {
  const f = fixture(t);
  f.writeProactive(`queries-${vacancyId}.json`, { vacancy_id: vacancyId,
    queries: ['вымышленный инженер'], config_hash: 'stale' });
  await assert.rejects(f.load(profileId, vacancyId), /private_search_plan_unavailable/);
  f.writeProactive(`queries-${vacancyId}.json`, { vacancy_id: vacancyId,
    queries: ['вымышленный инженер'], manual: true, config_hash: 'stale' });
  assert.equal((await f.load(profileId, vacancyId)).queryCache.manual, true,
    'explicit recruiter-pinned query can outlive generated cache hash');
  f.writeContext(`ats_config:${vacancyId}.json`, { value: { ...config, vacancy_id: 'other_vacancy' } });
  await assert.rejects(f.load(profileId, vacancyId), /private_search_plan_unavailable/);
  f.writeContext(`ats_config:${vacancyId}.json`, { value: { ...config, filters: { min_experience_years: 0 } } });
  await assert.rejects(f.load(profileId, vacancyId), /private_search_plan_unavailable/);
});

test('changed recruiter comments invalidate an old generated query cache', async t => {
  const f = fixture(t);
  f.writeProactive(`candidate-comments-${vacancyId}.json`, {
    syntheticresume01: { text: 'Не подходит вымышленный регион' } });
  await assert.rejects(f.load(profileId, vacancyId), /private_search_plan_unavailable/);
  f.writeProactive(`queries-${vacancyId}.json`, { vacancy_id: vacancyId,
    queries: ['вымышленный инженер без региона'], config_hash: legacyQueryConfigHash(config,
      ['Не подходит вымышленный регион']) });
  assert.deepEqual((await f.load(profileId, vacancyId)).queryCache.queries,
    ['вымышленный инженер без региона']);
});

test('untrusted binding and symlinked private source fail closed without printing content', async t => {
  const f = fixture(t);
  const cross = createPrivateBaseSearchPlan({ resolveProfileBinding: async () => ({ profileId: 'other_profile',
    contextDirectory: f.contextDirectory, proactiveDirectory: f.proactiveDirectory }),
  isVacancyOwned: () => true });
  await assert.rejects(cross(profileId, vacancyId), /private_search_plan_unavailable/);
  rmSync(join(f.proactiveDirectory, `queries-${vacancyId}.json`));
  symlinkSync(join(f.root, 'outside.json'), join(f.proactiveDirectory, `queries-${vacancyId}.json`));
  await assert.rejects(f.load(profileId, vacancyId), /private_search_plan_unavailable/);
});

test('bound private plan reaches the shared search handler and durable candidate state', async t => {
  const f = fixture(t);
  const state = new SqliteRealHhCandidateState({ filename: join(f.root, 'candidate.sqlite'),
    isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId });
  t.after(() => state.close());
  const loadSearchPlan = createReviewAwareSearchPlan({ loadBasePlan: f.load, candidateState: state,
    generateQueries: async () => { throw new Error('no feedback expected'); } });
  const plan = await loadSearchPlan(profileId, vacancyId);
  let providerCalls = 0;
  const search = createOfflineHhColdSearch({ loadSearchPlan, candidateState: state,
    transport: { search: async ({ trustedContext, vacancyId: requested, query, area }) => {
      providerCalls++;
      assert.equal(trustedContext.profileId, profileId);
      assert.equal(requested, vacancyId);
      assert.equal(query, 'вымышленный инженер');
      assert.deepEqual(area, config.filters.area);
      return { profileId, vacancyId, areas: ['1'], items: [{ id: 'syntheticresume01',
        title: 'Вымышленный инженер', first_name: 'Имя', last_name: 'Фамилия',
        area: { name: 'Вымышленный регион' }, total_experience: { months: 24 },
        experience: [{ position: 'инженер-конструктор', company: 'Вымышленная фабрика', start: '2024-01-01' }] }] };
    } }, clock: () => new Date('2026-10-06T06:00:00.000Z') });
  const result = await search.run({ trustedContext: { profileId, scopes: ['recruiting.candidateSearch'] },
    vacancyId, jobId: 'job_synthetic_private_plan', source: 'scheduled',
    expectedCriteriaRevision: plan.criteriaRevision, expectedQueryRevision: plan.queryCache.revision });
  assert.equal(result.snapshot.candidateCount, 1);
  assert.equal(state.seenTotal(profileId, vacancyId), 1);
  assert.equal(providerCalls, 1);
});
