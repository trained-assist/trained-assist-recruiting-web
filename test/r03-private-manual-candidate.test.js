import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecruitingServer } from '../src/server.js';
import { createR03AccumulatedRealFeed } from '../src/r03-accumulated-real-feed.js';
import { createR03PrivateManualCandidate } from '../src/r03-private-manual-candidate.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import Ajv2020 from 'ajv/dist/2020.js';

const profileId = 'invented_profile';
const vacancyId = 'invented_vacancy';
const resumeId = 'inventedresume1';
const trusted = { profileId, scopes: ['recruiting.candidateSearch'] };
const raw = { id: resumeId, title: 'Вымышленный инженер', first_name: 'Вымышленное', last_name: 'Имя',
  total_experience: { months: 12 }, area: { name: 'Вымышленный регион' },
  experience: [{ position: 'Инженер', company: 'Вымышленная компания', start: '2025-01-01', end: null }] };
const atsConfig = { vacancy_title: 'Вымышленная вакансия', filters: { min_experience_years: 3 },
  required: [], preferred: [], knockout: [] };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'r03-manual-candidate-'));
  const owned = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
  const state = new SqliteRealHhCandidateState({ filename: join(directory, 'private.sqlite'), isVacancyOwned: owned });
  t.after(() => { state.close(); rmSync(directory, { recursive: true, force: true }); });
  const feed = createR03AccumulatedRealFeed({ scheduleRepository: { listOccurrences: () => [] }, candidateState: state });
  const calls = [];
  const add = createR03PrivateManualCandidate({ candidateState: state,
    loadBasePlan: async (profile, vacancy, options) => {
      assert.deepEqual([profile, vacancy, options], [profileId, vacancyId, { allowGeneration: false }]);
      return { profileId, vacancyId, atsConfig };
    }, credentialBroker: { loadCredential: async profile => ({ profileId: profile, accessToken: 'invented_token' }),
      refreshCredential: async profile => ({ profileId: profile, accessToken: 'invented_refreshed_token' }) },
    isVacancyOwned: owned, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => raw };
    }, clock: () => new Date('2026-10-06T08:00:00.000Z') });
  return { state, feed, add, calls };
}

test('manual HH candidate is exact-vacancy, idempotent and visible without a search receipt', async t => {
  const f = fixture(t);
  const command = { vacancy_id: vacancyId, resume_url_or_id: `https://hh.ru/resume/${resumeId}?from=search` };
  assert.equal((await f.add({ profileId: 'other', scopes: trusted.scopes }, command)).status, 404);
  assert.equal((await f.add(trusted, { ...command, vacancy_id: 'other' })).status, 404);
  assert.equal((await f.add(trusted, { ...command, resume_url_or_id: 'https://evil.example/resume/inventedresume1' })).status, 400);
  assert.equal(f.calls.length, 0);
  const first = await f.add(trusted, command);
  assert.deepEqual(first, { status: 201, body: { ok: true, added: true, candidateId: resumeId } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `https://api.hh.ru/resumes/${resumeId}`);
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer invented_token');
  const morning = f.feed.read(trusted, vacancyId);
  assert.equal(morning.status, 'never_run');
  assert.equal(morning.freshness, 'never_run', 'manual add cannot claim search freshness');
  const items = morning.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'manual_add');
  assert.equal(items[0].jobId, null);
  assert.equal(items[0].id, resumeId);
  assert.equal(items[0].atsScore, null);
  assert.equal((await f.add(trusted, command)).body.added, false);
  assert.equal(f.calls.length, 1, 'repeat must not call HH');
  assert.equal(f.state.latestSnapshot(profileId, vacancyId), null, 'manual add is not a search');
});

test('HTTP manual add binds trusted profile and does not expose raw HH data', async t => {
  const f = fixture(t);
  const server = createRecruitingServer({ realProactiveFeed: f.feed, realProactiveManualCandidate: f.add,
    resolveTrustedProfileContext: req => req.headers['x-test-principal'] ?
      { profileId: req.headers['x-test-principal'], scopes: trusted.scopes } : null,
    resolveRealVacancyOwnership: (context, vacancy) => context.profileId === profileId && vacancy === vacancyId });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, profile = profileId) => fetch(`${base}/api/hh/proactive/add-manual`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(profile ? { 'X-Test-Principal': profile } : {}) },
    body: JSON.stringify(body) });
  const body = { vacancy_id: vacancyId, resume_url_or_id: resumeId };
  assert.equal((await post(body, null)).status, 401);
  assert.equal((await post(body, 'other')).status, 404);
  assert.equal((await post({ ...body, username: 'old' })).status, 400);
  const response = await post(body);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, added: true, candidateId: resumeId });
  const feed = await (await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=${vacancyId}`,
    { headers: { 'X-Test-Principal': profileId } })).json();
  assert.equal(feed.total, 1);
  assert.equal(feed.candidates[0].id, resumeId);
  const schema = JSON.parse(readFileSync(new URL('../contracts/v1-real-proactive-results.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(feed), true, JSON.stringify(validate.errors));
});

test('one credential refresh is bounded; mismatched HH ID and failed SQLite transaction publish nothing', async t => {
  const f = fixture(t);
  const owned = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
  let refreshes = 0;
  const authorizations = [];
  const add = createR03PrivateManualCandidate({ candidateState: f.state,
    loadBasePlan: async () => ({ profileId, vacancyId, atsConfig }),
    credentialBroker: { loadCredential: async () => ({ profileId, accessToken: 'old_token' }),
      refreshCredential: async () => { refreshes++; return { profileId, accessToken: 'new_token' }; } },
    isVacancyOwned: owned, fetchImpl: async (_url, options) => {
      authorizations.push(options.headers.Authorization);
      return authorizations.length === 1 ? { ok: false, status: 401 } :
        { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ...raw, id: 'wrong_resume' }) };
    } });
  const command = { vacancy_id: vacancyId, resume_url_or_id: resumeId };
  assert.equal((await add(trusted, command)).status, 502);
  assert.deepEqual(authorizations, ['Bearer old_token', 'Bearer new_token']);
  assert.equal(refreshes, 1);
  assert.equal(f.feed.read(trusted, vacancyId).items.length, 0);
  f.state.onStep = step => { if (step === 'manual_candidate') throw new Error('invented write failure'); };
  assert.equal((await f.add(trusted, command)).status, 503);
  assert.equal(f.state.hasManualCandidate(profileId, vacancyId, resumeId), false);
  assert.equal(f.feed.read(trusted, vacancyId).items.length, 0);
});
