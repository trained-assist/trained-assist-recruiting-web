import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRecruitingServer } from '../src/server.js';
import { createR03HistoricalRead } from '../src/r03-historical-read.js';

const profileId = 'invented_profile', vacancyId = 'invented_vacancy';
const trusted = { profileId, scopes: ['recruiting.candidateSearch'] };
const owner = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
const selected = new Map([[`${profileId}\0${vacancyId}`, {
  searchedAt: '2026-01-02T07:00:00.000Z', historicalRevision: 'invented_revision',
  candidates: [{ id: 'invented_resume', title: '<script>alert(1)</script>',
    first_name: 'Вымышленное', last_name: 'Имя', area: { name: 'Вымышленный регион' },
    score: 8, hh_url: 'javascript:alert(1)' }] }]]);

async function started(t, historicalRead) {
  const server = createRecruitingServer({ realProactiveFeed: { read: () => ({
    status: 'never_run', freshness: 'never_run', total: 0, items: [], resultRevision: 'invented_active_revision' }) },
  realProactiveHistoricalRead: historicalRead,
  resolveTrustedProfileContext: req => req.headers['x-test-principal'] ?
    { profileId: req.headers['x-test-principal'], scopes: req.headers['x-test-scope'] === 'deny' ? [] :
      ['recruiting.candidateSearch'] } : null,
  resolveRealVacancyOwnership: context => context.profileId === profileId,
  privateProactiveOnly: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('historical API/page and MCP-facing domain read agree; active feed stays never-run', async t => {
  const read = createR03HistoricalRead({ selected, isVacancyOwned: owner });
  const base = await started(t, read);
  const headers = { 'X-Test-Principal': profileId };
  const path = `/api/hh/proactive/history?vacancy_id=${vacancyId}`;
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + path, { headers: { ...headers, 'X-Test-Scope': 'deny' } })).status, 403);
  assert.equal((await fetch(base + path, { headers: { 'X-Test-Principal': 'invented_other' } })).status, 404);
  assert.equal((await fetch(base + '/api/hh/proactive/history?vacancy_id=invented_other', { headers })).status, 404);
  assert.equal((await fetch(base + path + '&unexpected=1', { headers })).status, 400);
  assert.equal((await fetch(base + path, { method: 'POST', headers })).status, 405);
  const api = await (await fetch(base + path, { headers })).json();
  assert.deepEqual(api, read.read(trusted, vacancyId).value, 'offline MCP operation uses this same domain read');
  assert.equal(api.status, 'historical_only');
  assert.equal(api.total, 1);
  assert.equal(api.candidates[0].score, 8);
  assert.equal('freshness' in api, false);
  assert.equal('newCount' in api, false);
  const pageResponse = await fetch(base + `/hh/proactive/history?vacancy_id=${vacancyId}`, { headers });
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /Исторические результаты/);
  assert.match(page, /не подтверждают свежесть/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(page, /<script>|javascript:alert/);
  assert.equal(pageResponse.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + `/api/hh/proactive/candidates?vacancy_id=${vacancyId}`, { headers })).status, 200);
  const active = await (await fetch(base + `/api/hh/proactive/candidates?vacancy_id=${vacancyId}`, { headers })).json();
  assert.equal(active.status, 'never_run');
  assert.equal(active.total, 0);
  assert.equal(active.freshness, 'never_run');
  const activePage = await (await fetch(base + `/hh/proactive?vacancy_id=${vacancyId}`, { headers })).text();
  assert.match(activePage, /Принятых результатов пока нет/);
  assert.match(activePage, /Исторические результаты/);
});

test('disabled historical route and quarantined or missing selection are denied', async t => {
  const headers = { 'X-Test-Principal': profileId };
  const base = await started(t, null);
  assert.equal((await fetch(base + `/api/hh/proactive/history?vacancy_id=${vacancyId}`, { headers })).status, 404);
  const empty = createR03HistoricalRead({ selected: new Map(), isVacancyOwned: owner });
  assert.equal(empty.read(trusted, vacancyId).kind, 'not_found');
  assert.equal(empty.has(trusted, vacancyId), false);
  assert.equal(empty.read({ profileId, scopes: [] }, vacancyId).kind, 'denied');
});
