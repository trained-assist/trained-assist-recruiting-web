import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createPrivateWebRuntime } from '../src/r03-private-web-runtime.js';
import { createPrivateWebAuth } from '../src/r03-private-web-auth.js';
import { renderRealProactivePage } from '../src/r03-real-proactive-page.js';

const profileId = 'invented_recruiter';
const legacyUsername = 'old_invented_login';
const vacancyId = 'invented_vacancy';
const secret = 'invented-legacy-page-secret-32-characters-minimum';

function fixture(t, vacancyIds = [vacancyId]) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'r03-private-web-')));
  chmodSync(directory, 0o700);
  const privateDir = name => { const path = join(directory, name); mkdirSync(path, { mode: 0o700 }); return path; };
  const contexts = privateDir('contexts');
  const proactive = privateDir('proactive');
  const tokens = privateDir('tokens');
  const secrets = privateDir('secrets');
  for (const [name, value] of Object.entries({ legacy_page_secret: secret,
    hh_encryption_key: 'a'.repeat(64), hh_client_id: 'invented-client',
    hh_client_secret: 'invented-client-secret', ladder_token: 'invented-ladder' }))
    writeFileSync(join(secrets, name), value, { mode: 0o600 });
  const configFile = join(directory, 'config.json');
  writeFileSync(configFile, JSON.stringify({ version: 'r03-private-host-v1',
    dbPath: join(directory, 'state.sqlite'), profiles: [{ profileId, legacyUsername, vacancyIds,
      contextDirectory: contexts, proactiveDirectory: proactive, tokenDirectory: tokens }] }), { mode: 0o600 });
  const server = createPrivateWebRuntime({ configFile, secretsDirectory: secrets,
    fetchImpl: async () => { throw new Error('unexpected_provider_call'); },
    clock: () => new Date('2026-10-06T08:00:00.000Z') });
  server.listen(0, '127.0.0.1');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const token = createHmac('sha256', secret).update(legacyUsername).digest('hex').slice(0, 16);
  return { server, token, dbPath: join(directory, 'state.sqlite') };
}

test('private web runtime accepts only exact old signed link then scopes session to configured vacancy', async t => {
  const { server, token } = fixture(t);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const link = `${base}/hh/proactive?username=${legacyUsername}&token=${token}&vacancy_id=${vacancyId}`;
  assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=${vacancyId}`)).status, 401);
  assert.equal((await fetch(link.replace(token, '0'.repeat(16)))).status, 401);
  assert.equal((await fetch(`${base}/hh/proactive?username=other&token=${token}&vacancy_id=${vacancyId}`)).status, 401);
  const pageResponse = await fetch(link);
  assert.equal(pageResponse.status, 200);
  const pageText = await pageResponse.text();
  assert.match(pageText, /Принятых результатов пока нет/);
  assert.match(pageText, /data-profile-id="invented_recruiter"/);
  const cookie = pageResponse.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  const auth = { Cookie: cookie.split(';')[0] };
  const scriptResponse = await fetch(`${base}/hh/proactive/app.js`, { headers: auth });
  assert.equal(scriptResponse.status, 200);
  assert.match(await scriptResponse.text(), /Idempotency-Key/);
  assert.match(pageResponse.headers.get('content-security-policy'), /script-src 'self'/);
  const tamperedCookie = auth.Cookie.slice(0, -1) + (auth.Cookie.endsWith('0') ? '1' : '0');
  assert.equal((await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=${vacancyId}`, {
    headers: { Cookie: tamperedCookie } })).status, 401);
  const results = await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=${vacancyId}`, { headers: auth });
  assert.equal(results.status, 200);
  assert.equal((await results.json()).total, 0);
  assert.equal((await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=other`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/vacancies`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/hh/proactive/prompt`, { headers: auth })).status, 400);
  const seenPath = `${base}/api/hh/proactive/import-seen`;
  const seenBody = JSON.stringify({ vacancy_id: vacancyId, ids: ['inventedresume1'] });
  assert.equal((await fetch(seenPath, { method: 'POST', headers: { ...auth,
    'Content-Type': 'application/json' }, body: seenBody })).status, 401);
  const seenResponse = await fetch(seenPath, { method: 'POST', headers: { ...auth,
    Origin: 'https://recruiter-assistant.ru', 'Content-Type': 'application/json' }, body: seenBody });
  assert.equal(seenResponse.status, 200);
  assert.equal((await seenResponse.json()).imported, 1);
  assert.equal((await fetch(`${base}/api/hh/proactive/search`, { method: 'POST', headers: auth,
    body: JSON.stringify({ vacancy_id: vacancyId }) })).status, 401, 'POST requires same public origin');
  assert.equal((await fetch(`${base}/api/hh/proactive/search`, { method: 'POST', headers: {
    ...auth, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ vacancy_id: vacancyId }) })).status, 401);
  assert.equal((await fetch(`${base}/api/hh/proactive/search`, { method: 'POST', headers: {
    ...auth, Origin: 'https://recruiter-assistant.ru', 'Content-Type': 'application/json' },
    body: JSON.stringify({ vacancy_id: 'other' }) })).status, 400);
});

test('unsigned vacancy selector never widens a legacy signed link to another profile or ambiguous default', async t => {
  const { server, token } = fixture(t, [vacancyId, 'invented_other_vacancy']);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = `/hh/proactive?username=${legacyUsername}&token=${token}`;
  assert.equal((await fetch(base + path)).status, 400);
  assert.equal((await fetch(base + path + '&vacancy_id=unowned')).status, 404);
  assert.equal((await fetch(base + path + `&vacancy_id=${vacancyId}`)).status, 200);
  assert.equal((await fetch(base + path + `&vacancy_id=${vacancyId}&username=${legacyUsername}`)).status, 401);
});

test('old open-tab JSON commands receive an actionable reload without executing writes', async t => {
  const { server, token, dbPath } = fixture(t);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, fields, headers = {}) => fetch(`${base}/api/hh/proactive/${route}`, {
    method: 'POST', headers: { Origin: 'https://recruiter-assistant.ru',
      'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ username: legacyUsername, token, ...fields }) });
  const oldCommands = [
    ['ai-score', { candidate_id: 'inventedresume1', vacancy_id: vacancyId }],
    ['search', { vacancy_id: vacancyId }],
    ['prompt', { vacancy_id: vacancyId, queries: 'invented search' }],
    ['comment', { vacancy_id: vacancyId, candidate_id: 'inventedresume1', text: 'Invented' }],
    ['vacancy-state', { vacancy_id: vacancyId, action: 'disable' }],
    ['set-status', { vacancy_id: vacancyId, candidate_id: 'inventedresume1', status: 'starred' }],
    ['import-seen', { ids: ['inventedresume1'] }],
    ['add-manual', { vacancy_id: vacancyId, resume_url_or_id: 'inventedresume1' }]
  ];
  for (const [route, fields] of oldCommands) {
    const response = await post(route, fields);
    assert.equal(response.status, 409, route);
    const body = await response.json();
    assert.equal(body.code, 'legacy_page_reload_required');
    assert.match(body.error, /Перезагрузите/);
    assert.equal(body.reload_url, '/hh/proactive');
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal((await post('import-seen', { vacancy_id: 'other', ids: ['inventedresume1'] })).status, 404);
  assert.equal((await post('search', { vacancy_id: vacancyId, token: '0'.repeat(16) })).status, 401);
  assert.equal((await post('search', { vacancy_id: vacancyId }, { Origin: 'https://evil.example' })).status, 401);
  assert.equal((await post('search', { vacancy_id: vacancyId, username: 'other' })).status, 401);
  assert.equal((await post('search', { vacancy_id: vacancyId }, { Cookie: '__Host-r03-proactive=invalid' })).status, 409);
  const page = await fetch(`${base}/hh/proactive?username=${legacyUsername}&token=${token}&vacancy_id=${vacancyId}`);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  for (const [route, fields] of oldCommands)
    assert.equal((await post(route, fields, { Cookie: cookie })).status, 409,
      `a new tab's cookie must not authorize the old ${route} payload`);
  const result = await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=${vacancyId}`, { headers: { Cookie: cookie } });
  assert.equal((await result.json()).total, 0);
  const db = new Database(dbPath, { readonly: true });
  t.after(() => db.close());
  for (const table of ['cold_search_schedules', 'real_hh_manual_run', 'real_hh_seen',
    'real_hh_assessment', 'real_hh_candidate_overlay', 'r03_private_query_override'])
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
});

test('removing legacy mapping revokes both signed entry and existing profile cookie', async () => {
  const mappings = new Map([[legacyUsername, profileId]]);
  const auth = createPrivateWebAuth({ legacySecret: secret,
    resolveLegacyProfile: username => mappings.get(username) ?? null,
    isWebProfileMapped: target => [...mappings.values()].includes(target),
    clock: () => Date.parse('2026-10-06T08:00:00.000Z') });
  const token = createHmac('sha256', secret).update(legacyUsername).digest('hex').slice(0, 16);
  const url = new URL(`https://recruiter-assistant.ru/hh/proactive?username=${legacyUsername}&token=${token}`);
  const headers = new Map();
  const first = await auth({ method: 'GET', headers: {} }, url, { setHeader: (key, value) => headers.set(key, value) });
  assert.equal(first.profileId, profileId);
  const cookie = headers.get('Set-Cookie').split(';')[0];
  mappings.clear();
  assert.equal(await auth({ method: 'GET', headers: {} }, url, { setHeader: () => {} }), null);
  assert.equal(auth.resolveLegacyOpenTab({ method: 'POST', headers: { origin: 'https://recruiter-assistant.ru' } },
    { username: legacyUsername, token, vacancy_id: vacancyId }), null);
  assert.equal(await auth({ method: 'GET', headers: { cookie } },
    new URL('https://recruiter-assistant.ru/api/hh/proactive/candidates'), { setHeader: () => {} }), null);
});

test('private result page does not link to an imported non-HH URL', () => {
  const page = renderRealProactivePage({ vacancyId, feed: { status: 'completed', freshness: 'latest_completed',
    total: 1, items: [{ title: 'Invented candidate', firstName: 'Invented', lastName: 'Person',
      area: 'Invented', atsScore: null, review: { status: 'active' }, comment: '',
      hhUrl: 'javascript:alert(1)' }] } });
  assert.doesNotMatch(page, /javascript:|Резюме HH/);
});
