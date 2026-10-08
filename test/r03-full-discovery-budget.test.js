import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intervalPlan, nextOccurrenceAfter } from '../src/cold-search-schedules.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { SqliteAcceptedAssessmentQueue } from '../src/sqlite-accepted-assessment-queue.js';
import { FULL_DISCOVERY_BUDGET, createFullDiscoveryCostPreflight,
  createBudgetedFullHhDiscovery } from '../src/r03-full-discovery-budget.js';

const profileId = 'invented_profile'; const vacancyId = 'invented_vacancy';
const queries = ['invented query A', 'invented query B'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const atsConfig = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
  vacancy_context: 'Вымышленный клиент', filters: { area: { id: '1' }, min_experience_years: 0 },
  required: [{ name: 'инженер', weight: 1 }], knockout: [] };
const item = id => ({ id, title: 'Вымышленный инженер', first_name: 'Вымышленное',
  last_name: 'Имя', area: { name: 'Вымышленная область' },
  total_experience: { months: 48 }, experience: [] });
const planFor = list => ({ profileId, vacancyId, criteriaRevision: 'criteria_invented_r1',
  queryCache: { revision: 'queries_invented_r1', queries: list }, atsConfig, area: { id: '1' } });
const preflightFor = (plan, due, found = 2) => createFullDiscoveryCostPreflight(plan,
  plan.queryCache.queries.map(query => ({ queryHash: hash(query), found, pagesAtOne: found })), due);

function fixture(t, { list = queries, found = 2, fetchImpl } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'r03-full-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = join(root, 'private.sqlite');
  const repository = new SqliteColdSearchScheduleRepository(filename);
  const state = new SqliteRealHhCandidateState({ filename,
    isVacancyOwned: (p, v) => p === profileId && v === vacancyId });
  t.after(() => { state.close(); repository.close(); });
  const initial = '2026-10-06T06:00:00.000Z';
  const schedulePlan = intervalPlan(24, vacancyId);
  const due = nextOccurrenceAfter(schedulePlan, initial);
  const plan = planFor(list);
  repository.upsertSchedule({ scheduleId: 'invented_schedule', legacyJobId: 'invented_job',
    profileId, vacancyId, enabled: true, plan: schedulePlan, timezone: 'Europe/Moscow',
    jobArguments: { vacancyId }, nextRunAt: due, leaseOwner: null, leaseUntil: null,
    blockedByUnknownOccurrenceId: null });
  let current = due;
  let calls = 0;
  const assessmentQueue = new SqliteAcceptedAssessmentQueue({ filename,
    candidateState: state, scheduleRepository: repository,
    evaluate: async () => ({ atsScore: 8, atsTag: 'PASS',
      knockout: { status: 'passed', criteria: [] } }),
    currentCriteriaRevision: async () => plan.criteriaRevision,
    clock: () => new Date(current) });
  t.after(() => assessmentQueue.close());
  const budgeted = createBudgetedFullHhDiscovery({ scheduleRepository: repository,
    candidateState: state, loadSearchPlan: async () => plan,
    loadCredential: async () => ({ profileId, accessToken: 'invented_token' }),
    loadVacancyContext: async () => ({ profileId, vacancyId, config: atsConfig }),
    fetchImpl: async (url, init) => { calls++; return fetchImpl(url, init); },
    userAgent: 'invented-recruiting/1.0 (contact@example.test)',
    preflightFor: async () => preflightFor(plan, due, found),
    assessmentQueue,
    clock: () => new Date(current) });
  return { repository, state, plan, due, budgeted,
    setNow: at => { current = at; }, get calls() { return calls; } };
}

test('preflight estimates bounded full search without pretending a probe is completion', () => {
  const plan = planFor(queries);
  const ready = preflightFor(plan, '2026-10-06T09:00:00.000Z', 1044);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.estimatedRequests, 42);
  assert.equal(ready.rawItemUpperBound, 2088);
  const wide = createFullDiscoveryCostPreflight(plan,
    queries.map(query => ({ queryHash: hash(query), found: 3000, pagesAtOne: 3000 })));
  assert.equal(wide.status, 'blocked');
  assert.equal(wide.reason, 'query_window_exceeds_budget');
  assert.equal(FULL_DISCOVERY_BUDGET.requests, 80);
  assert.equal(FULL_DISCOVERY_BUDGET.assessmentsPerTick, 10);
});

test('full queries and pages commit once; assessment remains explicit bounded backlog', async t => {
  const f = fixture(t, { list: ['invented query A'], found: 12,
    fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(new URL(url).searchParams.get('per_page'), '50');
      return { status: 200, ok: true, json: async () => ({ pages: 1, found: 12,
        items: Array.from({ length: 12 }, (_, index) => item(`inventedresume${index}`)) }) };
    } });
  assert.deepEqual(await f.budgeted.worker.tick('invented_worker'),
    { claimed: 1, completed: 1, rejected: 0, unknown: 0 });
  assert.equal(f.calls, 1);
  const morning = f.budgeted.morningResults(profileId, vacancyId);
  assert.equal(morning.freshness, 'latest_completed');
  assert.equal(morning.snapshot.candidateCount, 12);
  assert.equal(morning.assessmentStatus, 'assessment_pending');
  assert.equal(morning.assessmentPendingCount, 12);
  f.setNow(new Date(Date.parse(f.due) + 5 * 60_000).toISOString());
  const first = await f.budgeted.scoreTick(profileId, vacancyId, 'assessment_worker_a');
  assert.equal(first.written, 6);
  assert.equal(f.budgeted.morningResults(profileId, vacancyId).assessmentPendingCount, 6);
  const second = await f.budgeted.scoreTick(profileId, vacancyId, 'assessment_worker_b');
  assert.equal(second.written, 0);
  f.setNow(new Date(Date.parse(f.due) + 10 * 60_000).toISOString());
  const third = await f.budgeted.scoreTick(profileId, vacancyId, 'assessment_worker_c');
  assert.equal(third.written, 6);
  assert.equal(f.budgeted.morningResults(profileId, vacancyId).assessmentStatus, 'assessed');
  assert.equal((await f.budgeted.worker.tick('invented_worker_again')).claimed, 0);
  assert.equal(f.calls, 1);
});

test('stale preflight rejects before provider dispatch', async t => {
  const f = fixture(t, { fetchImpl: async () => { throw new Error('must not dispatch'); } });
  f.setNow(new Date(Date.parse(f.due) + 16 * 60_000).toISOString());
  const result = await f.budgeted.worker.tick('invented_worker');
  assert.equal(result.rejected, 1);
  assert.equal(f.calls, 0);
  assert.equal(f.repository.listOccurrences(profileId)[0].errorCode, 'search_budget_pre_dispatch');
  assert.equal(f.budgeted.morningResults(profileId, vacancyId).status, 'never_run');
});

test('later provider page failure and runtime request budget keep snapshot quarantined', async t => {
  const failed = fixture(t, { list: ['invented query A'], found: 2,
    fetchImpl: async url => new URL(url).searchParams.get('page') === '0'
      ? { status: 200, ok: true, json: async () => ({ pages: 2, found: 2, items: [item('inventedresume0')] }) }
      : { status: 429, ok: false, json: async () => ({}) } });
  assert.equal((await failed.budgeted.worker.tick('invented_worker')).unknown, 1);
  assert.equal(failed.calls, 2);
  assert.equal(failed.state.latestSnapshot(profileId, vacancyId), null);
  assert.equal(failed.budgeted.morningResults(profileId, vacancyId).freshness, 'latest_run_incomplete');

  const exceeded = fixture(t, { list: ['invented query A', 'invented query B', 'invented query C'], found: 1,
    fetchImpl: async (url) => ({ status: 200, ok: true, json: async () => ({ pages: 40,
      found: 40, items: [item(`inventedresume${new URL(url).searchParams.get('text').slice(-1)}${new URL(url).searchParams.get('page')}`)] }) }) });
  assert.equal((await exceeded.budgeted.worker.tick('invented_worker')).unknown, 1);
  assert.equal(exceeded.calls, 80);
  assert.equal(exceeded.repository.listOccurrences(profileId)[0].errorCode, 'provider_budget_exceeded_partial');
  assert.equal(exceeded.state.latestSnapshot(profileId, vacancyId), null);
  assert.equal(exceeded.budgeted.morningResults(profileId, vacancyId).status, 'never_run');
});

test('provider window growing beyond forty pages is typed partial and never fresh', async t => {
  const f = fixture(t, { list: ['invented query A'], found: 1,
    fetchImpl: async () => ({ status: 200, ok: true,
      json: async () => ({ pages: 41, found: 2050, items: [item('inventedresume')] }) }) });
  assert.equal((await f.budgeted.worker.tick('invented_worker')).unknown, 1);
  assert.equal(f.calls, 1);
  assert.equal(f.repository.listOccurrences(profileId)[0].errorCode, 'provider_window_partial');
  assert.equal(f.state.latestSnapshot(profileId, vacancyId), null);
  assert.equal(f.budgeted.morningResults(profileId, vacancyId).status, 'never_run');
});

test('raw candidate cap cannot publish a truncated full result', async t => {
  const f = fixture(t, { list: ['invented query A', 'invented query B'], found: 1,
    fetchImpl: async url => {
      const parsed = new URL(url);
      const query = parsed.searchParams.get('text').slice(-1);
      const page = Number(parsed.searchParams.get('page'));
      const pages = query === 'A' ? 40 : 21;
      return { status: 200, ok: true, json: async () => ({ pages, found: pages * 50,
        items: Array.from({ length: 50 }, (_, index) => item(`invented${query}${page}_${index}`)) }) };
    } });
  assert.equal((await f.budgeted.worker.tick('invented_worker')).unknown, 1);
  assert.equal(f.calls, 61);
  assert.equal(f.repository.listOccurrences(profileId)[0].errorCode, 'candidate_budget_exceeded_partial');
  assert.equal(f.state.latestSnapshot(profileId, vacancyId), null);
});
