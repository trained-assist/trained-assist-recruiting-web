import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRecruitingServer } from '../src/server.js';

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
});

test('default server keeps the existing synthetic page and API behavior', async t => {
  const base = await started(t, { resolveTrustedProfileContext: () => ({ profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] }) });
  const page = await fetch(base + '/hh/proactive?vacancy_id=vac_demo_001');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /proactive\/app\.js|proactive\.js/);
  const api = await (await fetch(base + '/api/hh/proactive/candidates?vacancy_id=vac_demo_001')).json();
  assert.equal(api.status, 'never_run');
});
