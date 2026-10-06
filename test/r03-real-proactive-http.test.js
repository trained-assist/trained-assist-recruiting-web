import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecruitingServer } from '../src/server.js';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { REAL_HH_RESULT_VERSION, SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { SqliteRealHhManualRuns } from '../src/sqlite-real-hh-manual-runs.js';
import { createR03AccumulatedRealFeedFromStores } from '../src/r03-accumulated-real-feed.js';
import { createRealProactiveRead } from '../src/r03-real-proactive-read.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { createR03RealProactiveActions } from '../src/r03-real-proactive-actions.js';

const vacancyId = 'vacancy_synthetic_real_001';
const profileId = 'profile_synthetic_real_001';
const headers = { 'X-Test-Principal': profileId };
const candidate = { id: 'syntheticresume1', title: '<script>alert(1)</script>', firstName: 'Вымышленное', lastName: 'Имя',
  area: 'Вымышленный регион', hhUrl: 'https://hh.ru/resume/syntheticresume1', atsScore: 8,
  review: { status: 'starred', revision: 1 }, comment: '<img src=x onerror=alert(1)>' };
const result = { status: 'completed', freshness: 'latest_run_incomplete', total: 1, resultRevision: 'synthetic_revision_1', items: [candidate] };

async function started(t, options) {
  const server = createRecruitingServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('opt-in real page and API use one trusted profile/vacancy feed; HTML escapes candidate text', async t => {
  const reads = [];
  const realProactiveFeed = { read: (context, vacancy) => { reads.push({ context, vacancy }); return result; } };
  const resolveTrustedProfileContext = req => req.headers['x-test-principal'] ?
    { profileId: req.headers['x-test-principal'], scopes: req.headers['x-test-scope'] === 'deny' ? [] : ['recruiting.candidateSearch'] } : null;
  const resolveRealVacancyOwnership = (context, vacancy) => context.profileId === profileId && vacancy === vacancyId;
  const base = await started(t, { realProactiveFeed, resolveTrustedProfileContext, resolveRealVacancyOwnership });
  const path = `/api/hh/proactive/candidates?vacancy_id=${vacancyId}`;
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + path, { headers: { ...headers, 'X-Test-Scope': 'deny' } })).status, 403);
  assert.equal((await fetch(base + path, { headers: { 'X-Test-Principal': 'profile_other' } })).status, 404);
  assert.equal((await fetch(base + '/hh/proactive?vacancy_id=vacancy_other', { headers })).status, 404);
  assert.equal(reads.length, 0, 'unowned and unauthenticated requests never read candidate data');
  const api = await (await fetch(base + path, { headers })).json();
  assert.equal(api.ok, true);
  assert.equal(api.freshness, 'latest_run_incomplete');
  assert.deepEqual(api.candidates, result.items);
  const pageResponse = await fetch(base + `/hh/proactive?vacancy_id=${vacancyId}`, { headers });
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(page, /Последний поиск не завершён/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(page, /<script>|<img src=x/);
  assert.equal(reads.length, 2);
  assert.equal(reads[0].context.profileId, profileId);
  assert.equal(reads[0].vacancy, vacancyId);
  assert.equal((await fetch(base + '/api/hh/proactive/search', { method: 'POST', headers })).status, 501,
    'real mode cannot fall through to the synthetic search writer');
  assert.equal((await fetch(base + '/api/hh/proactive/status', { headers })).status, 501,
    'unimplemented legacy namespace paths cannot fall through to synthetic routes');
});

test('default server keeps the existing synthetic page and API behavior', async t => {
  const base = await started(t, { resolveTrustedProfileContext: () => ({ profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] }) });
  const page = await fetch(base + '/hh/proactive?vacancy_id=vac_demo_001');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /proactive\/app\.js|proactive\.js/);
  const api = await (await fetch(base + '/api/hh/proactive/candidates?vacancy_id=vac_demo_001')).json();
  assert.equal(api.status, 'never_run');
});

test('durable manual receipt, assessment, HTTP page/API and MCP domain read share accepted real data', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'r03-real-http-'));
  const filename = join(directory, 'private.sqlite');
  const owned = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
  const state = new SqliteRealHhCandidateState({ filename, isVacancyOwned: owned });
  const ats = { filters: { min_experience_years: 0 }, required: [{ name: 'вымышленный критерий', weight: 1 }], knockout: [] };
  const mapped = n => mapHhResumeCandidate({ id: `syntheticresume${n}`, title: 'Вымышленный инженер',
    first_name: 'Вымышленное', last_name: 'Имя', total_experience: { months: 24 },
    area: { name: 'Вымышленный регион' }, salary: null,
    experience: [{ position: 'Вымышленный инженер', company: 'Вымышленная компания', start: '2021-01-01', end: null }]
  }, ats, vacancyId).candidate;
  let attempt = 0;
  const search = { run: async ({ jobId }) => {
    attempt++;
    const snapshot = state.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION, profileId, vacancyId,
      jobId, source: 'manual', searchedAt: `2026-10-06T0${attempt + 5}:00:00.000Z`,
      criteriaRevision: 'criteria_synthetic_r1', sourceRevision: 'source_synthetic_r1',
      totalCollected: 1, candidates: [mapped(attempt)] });
    if (attempt === 2) throw new Error('invented failure after commit');
    return { status: 'completed', snapshot };
  } };
  const manualRuns = new SqliteRealHhManualRuns({ filename, isVacancyOwned: owned,
    loadSearchPlan: async () => ({ profileId, vacancyId, criteriaRevision: 'criteria_synthetic_r1',
      queryCache: { revision: 'query_synthetic_r1', queries: ['invented query'] } }), search, candidateState: state });
  const schedules = new SqliteColdSearchScheduleRepository(filename);
  t.after(() => { schedules.close(); manualRuns.close(); state.close(); rmSync(directory, { recursive: true, force: true }); });
  const trusted = { profileId, scopes: ['recruiting.candidateSearch'] };
  const request = { vacancyId, criteriaRevision: 'criteria_synthetic_r1', queryRevision: 'query_synthetic_r1' };
  const first = await manualRuns.start(trusted, 'manual_key_synthetic_1', request);
  for (let i = 0; i < 30 && manualRuns.get(trusted, first.run.runId).run.status === 'running'; i++)
    await new Promise(resolve => setImmediate(resolve));
  assert.equal(manualRuns.get(trusted, first.run.runId).run.status, 'completed');
  const pending = state.unassessedLatest({ profileId, vacancyId })[0];
  assert.equal(state.recordAssessment({ profileId, vacancyId, jobId: pending.snapshot.jobId,
    candidateId: pending.candidate.id, inputRevision: pending.inputRevision,
    assessment: { atsScore: 8, atsTag: 'PASS', knockout: { status: 'passed', criteria: [] } },
    assessedAt: '2026-10-06T06:05:00.000Z' }).kind, 'written');
  const feed = createR03AccumulatedRealFeedFromStores({ scheduleRepository: schedules,
    candidateState: state, manualRuns });
  const actions = createR03RealProactiveActions({ scheduleRepository: schedules, manualRuns, feed,
    loadSearchPlan: async () => ({ profileId, vacancyId, criteriaRevision: 'criteria_synthetic_r1',
      queryCache: { revision: 'query_synthetic_r1', queries: ['invented query'] } }), isVacancyOwned: owned });
  const base = await started(t, { realProactiveFeed: feed,
    realProactiveActions: actions,
    resolveTrustedProfileContext: req => req.headers['x-test-principal'] === profileId ? trusted : null,
    resolveRealVacancyOwnership: (context, vacancy) => owned(context.profileId, vacancy) });
  const apiPath = `/api/hh/proactive/candidates?vacancy_id=${vacancyId}`;
  const api = await (await fetch(base + apiPath, { headers })).json();
  assert.equal(api.total, 1);
  assert.equal(api.candidates[0].atsScore, 8);
  const mcpRead = createRealProactiveRead({ feed, resolveVacancyOwnership: (context, vacancy) => owned(context.profileId, vacancy) });
  assert.deepEqual((await mcpRead(trusted, vacancyId)).value, api, 'MCP-facing domain operation and HTTP share one projection');
  assert.equal((await mcpRead({ profileId, scopes: [] }, vacancyId)).kind, 'denied');
  assert.match(await (await fetch(base + `/hh/proactive?vacancy_id=${vacancyId}`, { headers })).text(), /ATS: 8/);
  const post = (path, body, key = null) => fetch(base + path, { method: 'POST', headers: { ...headers,
    'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('/api/hh/proactive/vacancy-state', { vacancy_id: vacancyId, action: 'enable', interval_hours: 24 })).status, 200);
  assert.equal((await (await fetch(base + `/api/hh/proactive/schedule?vacancy_id=${vacancyId}`, { headers })).json()).schedules.length, 1);
  assert.equal((await (await fetch(base + `/api/hh/proactive/occurrences?vacancy_id=${vacancyId}`, { headers })).json()).occurrences.length, 0);
  assert.equal((await post('/api/hh/proactive/comment', { vacancy_id: vacancyId, candidate_id: mapped(1).id,
    expected_revision: 0, comment: 'Вымышленная заметка', exclude_from_search: true })).status, 200);
  assert.equal((await post('/api/hh/proactive/set-status', { vacancy_id: vacancyId, candidate_id: mapped(1).id,
    expected_revision: 1, status: 'starred' })).status, 200);
  assert.equal((await post('/api/hh/proactive/set-status', { vacancy_id: vacancyId, candidate_id: mapped(1).id,
    expected_revision: 0, status: 'archived' })).status, 409);
  const reviewed = await (await fetch(base + apiPath, { headers })).json();
  assert.equal(reviewed.candidates[0].review.status, 'starred');
  assert.equal(reviewed.candidates[0].comment, 'Вымышленная заметка');
  const second = await manualRuns.start(trusted, 'manual_key_synthetic_2', request);
  for (let i = 0; i < 30 && manualRuns.get(trusted, second.run.runId).run.status === 'running'; i++)
    await new Promise(resolve => setImmediate(resolve));
  assert.equal(manualRuns.get(trusted, second.run.runId).run.status, 'outcome_unknown');
  const afterUnknown = await (await fetch(base + apiPath, { headers })).json();
  assert.equal(afterUnknown.total, 1);
  assert.equal(afterUnknown.candidates[0].id, mapped(1).id);
  assert.equal((await (await fetch(base + `/api/hh/proactive/manual-runs/${second.run.runId}`, { headers })).json()).run.status, 'outcome_unknown');
  const thirdResponse = await post('/api/hh/proactive/search', { vacancy_id: vacancyId }, 'manual_key_synthetic_3');
  assert.equal(thirdResponse.status, 202);
  const third = (await thirdResponse.json()).run;
  for (let i = 0; i < 30 && manualRuns.get(trusted, third.runId).run.status === 'running'; i++)
    await new Promise(resolve => setImmediate(resolve));
  assert.equal((await (await fetch(base + `/api/hh/proactive/manual-runs/${third.runId}`, { headers })).json()).run.status, 'completed');
  assert.equal((await (await fetch(base + apiPath, { headers })).json()).total, 2);
});
