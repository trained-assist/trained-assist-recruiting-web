import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHhResumeTransport } from '../src/hh-resume-transport.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { createOfflineHhColdSearch, HhColdSearchRunError } from '../src/hh-cold-search-offline.js';

const profileId = 'profile_synthetic_001';
const vacancyId = 'vacancy_synthetic_001';
const trustedContext = { profileId, scopes: ['recruiting.candidateSearch'] };
const queries = Array.from({ length: 6 }, (_, n) => `invented query ${n + 1}`);
const atsConfig = { vacancy_id: vacancyId, filters: { min_experience_years: 0, area: [1] }, required: [{ name: 'синтетический инженер', weight: 2 }] };
const plan = { profileId, vacancyId, criteriaRevision: 'criteria_synthetic_r1', queryCache: { revision: 'query_synthetic_r1', queries }, atsConfig, area: null };
const request = (jobId = 'job_synthetic_001', source = 'scheduled') => ({ trustedContext, vacancyId, jobId, source,
  expectedCriteriaRevision: plan.criteriaRevision, expectedQueryRevision: plan.queryCache.revision });
const item = id => ({ id, title: 'Синтетический инженер', first_name: 'Вымышленное', last_name: 'Имя',
  area: { name: 'Вымышленный регион' }, total_experience: { months: 48 }, experience: [{ position: 'синтетический инженер', company: 'Вымышленное бюро' }] });
const response = (status, body = { items: [] }) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

function fixture(t, { failAtQuery = null, queryCount = 6, area = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'offline-hh-orchestration-'));
  const filename = join(directory, 'private.sqlite');
  const state = new SqliteRealHhCandidateState({ filename, isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId });
  t.after(() => { if (state.db.open) state.close(); rmSync(directory, { recursive: true, force: true }); });
  const calls = [];
  const currentPlan = { ...plan, area, queryCache: { ...plan.queryCache, queries: queries.slice(0, queryCount) } };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const query = parsed.searchParams.get('text');
    calls.push({ query, areas: parsed.searchParams.getAll('area'), perPage: parsed.searchParams.get('per_page'), auth: init.headers.Authorization });
    if (query === failAtQuery) return response(503);
    const index = currentPlan.queryCache.queries.indexOf(query);
    if (index < 0) throw new Error('unexpected query');
    return response(200, { items: Array.from({ length: 50 }, (_, n) => item(n === 0 ? 'sharedsyntheticresume' : `syntheticresume${index}x${n}`)) });
  };
  const transport = createHhResumeTransport({ loadVacancyContext: async (profile, vacancy) => ({ profileId: profile, vacancyId: vacancy, config: atsConfig }),
    loadCredential: async profile => ({ profileId: profile, accessToken: 'invented-token' }), fetchImpl, sleep: async () => {} });
  let now = '2026-10-06T06:00:00.000Z';
  const loadSearchPlan = async () => currentPlan;
  const search = createOfflineHhColdSearch({ loadSearchPlan, transport, candidateState: state, clock: () => new Date(now) });
  return { filename, state, calls, search, currentPlan, setNow: value => { now = value; } };
}

test('six mock HH queries dedupe a 295-candidate pool and commit one scheduled snapshot; manual uses same handler', async t => {
  const { filename, state, calls, search, setNow } = fixture(t);
  const result = await search.run(request());
  assert.equal(result.status, 'completed');
  assert.equal(result.snapshot.totalCollected, 295);
  assert.equal(result.snapshot.candidateCount, 295);
  assert.equal(result.snapshot.newCount, 295);
  assert.equal(state.seenTotal(profileId, vacancyId), 295);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map(call => call.perPage), Array(6).fill('50'));
  assert.deepEqual(calls.map(call => call.areas), Array(6).fill([]));
  assert.deepEqual(calls.map(call => call.auth), Array(6).fill('Bearer invented-token'));
  assert.equal(result.snapshot.criteriaRevision, plan.criteriaRevision);
  assert.match(result.snapshot.sourceRevision, /^hh-search-[a-f0-9]{24}$/);
  assert.equal((await search.run(request())).replayed, true);
  assert.equal(calls.length, 6, 'same job does not repeat provider read');
  setNow('2026-10-06T07:00:00.000Z');
  const manual = await search.run(request('job_synthetic_002', 'manual'));
  assert.equal(manual.snapshot.source, 'manual');
  assert.equal(manual.snapshot.newCount, 0);
  assert.equal(state.seenTotal(profileId, vacancyId), 295);
  state.close();
  const restarted = new SqliteRealHhCandidateState({ filename, isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId });
  t.after(() => { if (restarted.db.open) restarted.close(); });
  let cursor = null;
  const ids = [];
  do {
    const page = restarted.resultPage({ profileId, vacancyId, jobId: result.snapshot.jobId, cursor, limit: 75 });
    ids.push(...page.items.map(candidate => candidate.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 295);
  assert.equal(new Set(ids).size, 295);
  assert.equal(restarted.latestSnapshot(profileId, vacancyId).jobId, manual.snapshot.jobId);
  assert.equal(restarted.seenTotal(profileId, vacancyId), 295);
});

test('mid-batch provider failure does not publish partial candidates or freshness', async t => {
  const { state, calls, search } = fixture(t, { failAtQuery: queries[2] });
  await assert.rejects(search.run(request()), error => error instanceof HhColdSearchRunError && error.code === 'provider_search_failed');
  assert.equal(calls.length, 5, 'third query gets two bounded retries');
  assert.equal(state.latestSnapshot(profileId, vacancyId), null);
  assert.equal(state.seenTotal(profileId, vacancyId), 0);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM real_hh_candidate').get().count, 0);
});

test('multiple HH pages per query commit together and a later page failure commits none', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'offline-hh-pages-'));
  const state = new SqliteRealHhCandidateState({ filename: join(directory, 'private.sqlite'),
    isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId });
  t.after(() => { if (state.db.open) state.close(); rmSync(directory, { recursive: true, force: true }); });
  let failSecondPage = true;
  const calls = [];
  const transport = createHhResumeTransport({
    loadVacancyContext: async (profile, vacancy) => ({ profileId: profile, vacancyId: vacancy, config: atsConfig }),
    loadCredential: async profile => ({ profileId: profile, accessToken: 'invented-token' }),
    fetchImpl: async url => {
      const page = Number(new URL(url).searchParams.get('page'));
      calls.push(page);
      return page === 1 && failSecondPage ? response(503) : response(200, {
        items: Array.from({ length: 50 }, (_, n) => item(`syntheticpage${page}resume${n}`)), pages: 2, found: 100
      });
    }, sleep: async () => {}
  });
  const oneQueryPlan = { ...plan, queryCache: { revision: 'paged-r1', queries: [queries[0]] } };
  const search = createOfflineHhColdSearch({ loadSearchPlan: async () => oneQueryPlan, transport, candidateState: state });
  const run = () => search.run({ ...request(), expectedQueryRevision: oneQueryPlan.queryCache.revision });
  await assert.rejects(run(), /provider_search_failed/);
  assert.deepEqual(calls, [0, 1, 1, 1]);
  assert.equal(state.latestSnapshot(profileId, vacancyId), null);
  assert.equal(state.seenTotal(profileId, vacancyId), 0);
  failSecondPage = false;
  const completed = await run();
  assert.equal(completed.snapshot.candidateCount, 100);
  assert.equal(state.seenTotal(profileId, vacancyId), 100);
});

test('four cached queries use explicit numeric HH area instead of ATS default', async t => {
  const { search, calls, state } = fixture(t, { queryCount: 4, area: [{ id: 77 }] });
  const result = await search.run(request());
  assert.equal(result.snapshot.candidateCount, 197);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => call.areas), [['77'], ['77'], ['77'], ['77']]);
  assert.equal(state.seenTotal(profileId, vacancyId), 197);
});

test('one recruiter-pinned query remains valid under the legacy query-editor contract', async t => {
  const { search, calls } = fixture(t, { queryCount: 1 });
  const result = await search.run(request());
  assert.equal(result.snapshot.candidateCount, 50);
  assert.equal(calls.length, 1);
});

test('query cache and criteria revisions fail closed before fetch; stale plan after fetch fails before commit', async t => {
  const { state, calls, search, currentPlan } = fixture(t);
  await assert.rejects(search.run({ ...request(), expectedQueryRevision: 'stale' }), /search_plan_unavailable/);
  assert.equal(calls.length, 0);
  const old = currentPlan.queryCache.revision;
  let reads = 0;
  const dynamic = createOfflineHhColdSearch({
    loadSearchPlan: async () => { reads++; return reads === 1 ? currentPlan : { ...currentPlan, queryCache: { ...currentPlan.queryCache, revision: `${old}_changed` } }; },
    transport: { search: async ({ query }) => ({ profileId, vacancyId, areas: [], items: [item(`synthetic${query.replace(/\W/g, '')}`)] }) },
    candidateState: state
  });
  await assert.rejects(dynamic.run(request()), /search_plan_stale/);
  assert.equal(state.latestSnapshot(profileId, vacancyId), null);
});

test('candidate name in provider failure cannot enter logs or error message', async t => {
  const privateName = 'PRIVATE_SYNTHETIC_CANDIDATE_NAME';
  const { search } = fixture(t, { failAtQuery: queries[1] });
  const logs = [];
  const original = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...parts) => logs.push(parts.join(' '));
  try {
    await assert.rejects(search.run(request()), error => !String(error).includes(privateName));
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(privateName));
  } finally { [console.log, console.warn, console.error] = original; }
});
