import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRecruitingServer } from '../src/server.js';
import { createR03PrivateAiScore } from '../src/r03-private-ai-score.js';

const profileId = 'invented_profile';
const vacancyId = 'invented_vacancy';
const candidateId = 'invented_resume';
const jobId = 'invented_job';
const context = { profileId, scopes: ['recruiting.candidateSearch'] };
const command = { vacancy_id: vacancyId, candidate_id: candidateId, expected_job_id: jobId };
const assessment = { atsScore: 8, atsTag: 'PASS', knockout: { status: 'passed', criteria: [] } };

function fixture({ evaluate: injectedEvaluate = null, timeoutMs = 1000 } = {}) {
  let latest = jobId;
  let criteria = 'criteria_r1';
  let stored = null;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const item = { id: candidateId, jobId, atsScore: null };
  const feed = { read: () => ({ items: [item] }) };
  const state = {
    assessmentForLatest: () => latest !== jobId ? { kind: 'stale' } : stored ?
      { kind: 'scored', assessment: stored } : { kind: 'pending', snapshot: { criteriaRevision: 'criteria_r1' },
        candidate: { id: candidateId, vacancyId }, inputRevision: 'a'.repeat(32) },
    recordAssessment: ({ assessment: value }) => { stored = value; Object.assign(item, value); return { kind: 'written' }; },
    recordAssessmentFailure: () => ({ kind: 'deferred' })
  };
  const score = createR03PrivateAiScore({ feed, candidateState: state,
    loadBasePlan: async () => ({ profileId, vacancyId, criteriaRevision: criteria }),
    evaluate: async request => { calls++; return injectedEvaluate ? injectedEvaluate(request) : gate.then(() => assessment); },
    isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId,
    clock: () => new Date('2026-10-06T08:00:00.000Z'), timeoutMs });
  return { score, feed, state, release, get calls() { return calls; },
    setCriteria: value => { criteria = value; }, setLatest: value => { latest = value; },
    get stored() { return stored; } };
}

test('on-demand ATS scores one accepted latest candidate, dedupes concurrent clicks and fences scope/revision', async () => {
  const f = fixture();
  assert.equal((await f.score({ profileId: 'other', scopes: context.scopes }, command)).status, 404);
  assert.equal((await f.score(context, { ...command, vacancy_id: 'other' })).status, 404);
  assert.equal((await f.score(context, { ...command, expected_job_id: 'old_job' })).status, 409);
  assert.equal((await f.score(context, { ...command, candidate_id: 'unknown' })).status, 404);
  const first = f.score(context, command);
  const second = f.score(context, command);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls, 1);
  f.release();
  assert.deepEqual(await first, { status: 200, body: { ok: true, cached: false, ...assessment } });
  assert.deepEqual(await second, { status: 200, body: { ok: true, cached: false, ...assessment } });
  assert.equal((await f.score(context, command)).body.cached, true);
  assert.equal(f.calls, 1);
  f.setLatest('newer_unaccepted_job');
  assert.equal((await f.score(context, command)).body.cached, true, 'existing accepted assessment remains readable');
});

test('criteria change and a newer unaccepted snapshot prevent publication', async () => {
  const changed = fixture();
  const pending = changed.score(context, command);
  await new Promise(resolve => setImmediate(resolve));
  changed.setCriteria('criteria_r2');
  changed.release();
  assert.equal((await pending).status, 409);
  assert.equal(changed.stored, null);
  const newer = fixture();
  newer.setLatest('newer_unaccepted_job');
  assert.equal((await newer.score(context, command)).body.error, 'candidate_not_in_latest_snapshot');
  assert.equal(newer.calls, 0);
});

test('bounded scorer timeout hides provider details and publishes no score', async () => {
  const f = fixture({ evaluate: async () => new Promise(() => {}), timeoutMs: 10 });
  const result = await f.score(context, command);
  assert.deepEqual(result, { status: 503, body: { error: 'assessment_unavailable' } });
  assert.equal(f.calls, 1);
  assert.equal(f.stored, null);
});

test('HTTP ai-score uses trusted profile and exact target command', async t => {
  const f = fixture();
  f.release();
  const server = createRecruitingServer({ realProactiveFeed: f.feed, realProactiveAiScore: f.score,
    resolveTrustedProfileContext: req => req.headers['x-test-principal'] ?
      { profileId: req.headers['x-test-principal'], scopes: context.scopes } : null,
    resolveRealVacancyOwnership: (trusted, vacancy) => trusted.profileId === profileId && vacancy === vacancyId });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/hh/proactive/ai-score`;
  const post = (body, principal = profileId) => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(principal ? { 'X-Test-Principal': principal } : {}) },
    body: JSON.stringify(body) });
  assert.equal((await post(command, null)).status, 401);
  assert.equal((await post(command, 'other')).status, 404);
  assert.equal((await post({ ...command, extra: 'old-token' })).status, 400);
  const result = await post(command);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).atsScore, 8);
  assert.equal((await post(command)).status, 200);
  assert.equal(f.calls, 1);
});
