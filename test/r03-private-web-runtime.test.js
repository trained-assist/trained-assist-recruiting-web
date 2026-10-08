import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createPrivateWebRuntime, parsePrivateWebArgs } from '../src/r03-private-web-runtime.js';
import { createPrivateWebAuth } from '../src/r03-private-web-auth.js';
import { renderRealProactivePage } from '../src/r03-real-proactive-page.js';

const profileId = 'invented_recruiter';
const legacyUsername = 'old_invented_login';
const vacancyId = 'invented_vacancy';
const secret = 'invented-legacy-page-secret-32-characters-minimum';

function fixture(t, vacancyIds = [vacancyId], runtimeOptions = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'r03-private-web-')));
  chmodSync(directory, 0o700);
  const privateDir = name => { const path = join(directory, name); mkdirSync(path, { mode: 0o700 }); return path; };
  const contexts = privateDir('contexts');
  const proactive = privateDir('proactive');
  const tokens = privateDir('tokens');
  const secrets = privateDir('secrets');
  const reportDraftDbPath = runtimeOptions.reportDraftDbPath === 'fixture'
    ? join(directory, 'reports.sqlite') : runtimeOptions.reportDraftDbPath;
  for (const [name, value] of Object.entries({ ...(runtimeOptions.connectedAppBff || runtimeOptions.connectedBffConfig ? {} : { legacy_page_secret: secret }),
    hh_encryption_key: 'a'.repeat(64), hh_client_id: 'invented-client',
    hh_client_secret: 'invented-client-secret', ladder_token: 'invented-ladder',
    ...(runtimeOptions.connectedBffConfig ? { cp_service_key: 'invented-service-key-32-characters-minimum',
      bff_encryption_key: 'b'.repeat(64) } : {}),
    ...(reportDraftDbPath ? { report_drafts_encryption_key: 'c'.repeat(64) } : {}),
    hh_user_agent: 'invented-recruiting/1.0 (contact@example.test)' }))
    writeFileSync(join(secrets, name), value, { mode: 0o600 });
  const configFile = join(directory, 'config.json');
  writeFileSync(configFile, JSON.stringify({ version: 'r03-private-host-v1',
    dbPath: join(directory, 'state.sqlite'), profiles: [{ profileId, legacyUsername, vacancyIds,
      contextDirectory: contexts, proactiveDirectory: proactive, tokenDirectory: tokens }] }), { mode: 0o600 });
  const server = createPrivateWebRuntime({ configFile, secretsDirectory: secrets,
    fetchImpl: async () => { throw new Error('unexpected_provider_call'); },
    clock: () => new Date('2026-10-06T08:00:00.000Z'), ...runtimeOptions,
    ...(reportDraftDbPath ? { reportDraftDbPath } : {}),
    ...(runtimeOptions.connectedBffConfig ? { connectedBffConfig: {
      ...runtimeOptions.connectedBffConfig, dbPath: join(directory, 'bff.sqlite') } } : {}) });
  server.listen(0, '127.0.0.1');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const token = createHmac('sha256', secret).update(legacyUsername).digest('hex').slice(0, 16);
  return { server, token, dbPath: join(directory, 'state.sqlite'), reportDraftDbPath };
}

test('private runtime can use injected Connected App BFF without legacy page secret', async t => {
  const bff = { resolve: async () => ({ profileId, scopes: ['recruiting.candidateSearch'] }),
    handle: async () => false };
  const { server } = fixture(t, [vacancyId], { connectedAppBff: bff });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=${vacancyId}`)).status, 200);
  assert.equal((await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=${vacancyId}`)).status, 200);
  assert.equal((await fetch(`${base}/hh/candidate-report?vacancy_id=${vacancyId}&candidate_id=synthetic_candidate`)).status, 404,
    'report route is absent unless a separate encrypted report database is explicitly configured');
  assert.equal((await fetch(`${base}/hh/proactive?username=${legacyUsername}&token=deadbeef&vacancy_id=${vacancyId}`)).status, 400);
});

test('private CLI keeps BFF opt-in and requires exact issuer, origin and durable path together', () => {
  const common = ['--live-execution', '--config', '/private/config.json', '--secrets', '/private/secrets', '--port', '18083'];
  assert.equal(parsePrivateWebArgs(common).connectedBffConfig, undefined);
  assert.throws(() => parsePrivateWebArgs([...common, '--connected-bff']));
  assert.throws(() => parsePrivateWebArgs([...common, '--cp-issuer', 'https://cp.example.invalid']));
  const args = parsePrivateWebArgs([...common, '--connected-bff', '--cp-issuer', 'https://cp.example.invalid',
    '--public-origin', 'https://recruiter-assistant.ru', '--bff-db', '/private/bff.sqlite']);
  assert.deepEqual(args.connectedBffConfig, { issuer: 'https://cp.example.invalid',
    publicOrigin: 'https://recruiter-assistant.ru', dbPath: '/private/bff.sqlite' });
  assert.throws(() => parsePrivateWebArgs([...common, '--report-drafts-db', '/private/reports.sqlite']));
  const reportArgs = parsePrivateWebArgs([...common, '--connected-bff', '--cp-issuer', 'https://cp.example.invalid',
    '--public-origin', 'https://recruiter-assistant.ru', '--bff-db', '/private/bff.sqlite',
    '--report-drafts-db', '/private/reports.sqlite']);
  assert.equal(reportArgs.reportDraftDbPath, '/private/reports.sqlite');
});

test('explicit report database mounts report routes and is owner-only; BFF alone leaves them absent', async t => {
  const scopes = ['recruiting.candidateSearch', 'recruiting.reports.read', 'recruiting.reports.create', 'recruiting.reports.edit', 'recruiting.reports.review'];
  const bff = { resolve: async () => ({ profileId, scopes }), handle: async () => false };
  const f = fixture(t, [vacancyId], { connectedAppBff: bff, reportDraftDbPath: 'fixture' });
  await once(f.server, 'listening');
  assert.equal(statSync(f.reportDraftDbPath).mode & 0o777, 0o600);
  const base = `http://127.0.0.1:${f.server.address().port}`;
  const response = await fetch(`${base}/hh/candidate-report?vacancy_id=${vacancyId}&candidate_id=synthetic_candidate&source_kind=accepted_hh_response`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Черновик отчёта кандидата/);
});

test('private BFF persists browser session across web restart, rejects replay, CSRF, outage and profile switch', async t => {
  const issuer = 'https://cp.example.invalid';
  const origin = 'https://recruiter-assistant.ru';
  const now = Date.parse('2026-10-06T08:00:00.000Z');
  const token = 'a'.repeat(64);
  let claims = { active: true, iss: issuer, aud: 'recruiting-web', sub: 'invented_user',
    profileId, sessionId: 'invented_session', nbf: now / 1000 - 1, exp: now / 1000 + 300,
    scopes: ['recruiting.candidateSearch'] };
  let exchanges = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, 'Bearer invented-service-key-32-characters-minimum');
    if (url === `${issuer}/v1/connected-app-sessions/exchange`) {
      exchanges++;
      return { ok: true, json: async () => ({ token, expiresAt: now / 1000 + 300 }) };
    }
    if (url === `${issuer}/v1/connected-app-sessions/introspect`) {
      if (claims === null) throw new Error('cp unavailable');
      return { ok: true, json: async () => claims };
    }
    throw new Error('unexpected outbound call');
  };
  const f = fixture(t, [vacancyId, 'second_vacancy'], { connectedBffConfig: { issuer, publicOrigin: origin }, fetchImpl });
  await once(f.server, 'listening');
  const base = `http://127.0.0.1:${f.server.address().port}`;
  const direct = await fetch(`${base}/hh/proactive?vacancy_id=${vacancyId}`, { redirect: 'manual' });
  assert.equal(direct.status, 303);
  assert.equal(direct.headers.get('location'), `/auth/connected/start?from=proactive&vacancy_id=${vacancyId}`);
  const start = await fetch(`${base}${direct.headers.get('location')}`, { redirect: 'manual' });
  assert.equal(start.status, 303);
  const pending = start.headers.getSetCookie().find(x => x.startsWith('__Host-recruiting-oauth-pending=')).split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = `${base}/auth/connected/callback?code=${'c'.repeat(64)}&state=${state}&iss=${encodeURIComponent(issuer)}`;
  const accepted = await fetch(callback, { redirect: 'manual', headers: { cookie: pending } });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get('location'), `${origin}/hh/proactive?vacancy_id=${vacancyId}`);
  assert.equal(exchanges, 1);
  const session = accepted.headers.getSetCookie().find(x => x.startsWith('__Host-recruiting-app-session=')).split(';')[0];
  assert.equal((await fetch(callback, { redirect: 'manual', headers: { cookie: pending } })).status, 401);
  assert.equal(exchanges, 1);
  assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=${vacancyId}`, { headers: { cookie: session } })).status, 200);
  const picker = await fetch(`${base}/hh/proactive`, { headers: { cookie: session } });
  assert.equal(picker.status, 200);
  const pickerHtml = await picker.text();
  assert.match(pickerHtml, /vacancy_id=invented_vacancy/);
  assert.match(pickerHtml, /vacancy_id=second_vacancy/);
  assert.doesNotMatch(pickerHtml, /candidate|token-secret|other_profile/);
  assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=foreign_vacancy`,
    { headers: { cookie: session } })).status, 404);
  const chooser = await fetch(`${base}/auth/connected/start?from=proactive`, { redirect: 'manual' });
  const chooserPending = chooser.headers.getSetCookie().find(x => x.startsWith('__Host-recruiting-oauth-pending=')).split(';')[0];
  const chooserState = new URL(chooser.headers.get('location')).searchParams.get('state');
  const chooserCallback = await fetch(`${base}/auth/connected/callback?code=${'d'.repeat(64)}&state=${chooserState}&iss=${encodeURIComponent(issuer)}`,
    { redirect: 'manual', headers: { cookie: chooserPending } });
  assert.equal(chooserCallback.headers.get('location'), `${origin}/hh/proactive`);
  const sessionInfo = await (await fetch(`${base}/auth/connected/session`, { headers: { cookie: session } })).json();
  const command = () => fetch(`${base}/api/hh/proactive/vacancy-state`, { method: 'POST',
    headers: { cookie: session, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ vacancy_id: vacancyId, enabled: false }) });
  assert.equal((await command()).status, 401);
  const acceptedCommand = await fetch(`${base}/api/hh/proactive/vacancy-state`, { method: 'POST',
    headers: { cookie: session, origin, 'x-csrf-token': sessionInfo.csrfToken,
      'content-type': 'application/json' },
    body: JSON.stringify({ vacancy_id: vacancyId, action: 'disable' }) });
  assert.notEqual(acceptedCommand.status, 401);
  await new Promise(resolve => f.server.close(resolve));
  const restarted = createPrivateWebRuntime({ configFile: join(f.dbPath, '..', 'config.json'),
    secretsDirectory: join(f.dbPath, '..', 'secrets'), fetchImpl,
    clock: () => new Date(now), connectedBffConfig: { issuer, publicOrigin: origin,
      dbPath: join(f.dbPath, '..', 'bff.sqlite') } });
  restarted.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => restarted.close(resolve)));
  await once(restarted, 'listening');
  const restartedBase = `http://127.0.0.1:${restarted.address().port}`;
  assert.equal((await fetch(`${restartedBase}/hh/proactive?vacancy_id=${vacancyId}`,
    { headers: { cookie: session } })).status, 200);
  claims = null;
  assert.equal((await fetch(`${restartedBase}/hh/proactive?vacancy_id=${vacancyId}`,
    { headers: { cookie: session } })).status, 503);
  claims = { active: true, ...claims, iss: issuer, aud: 'recruiting-web', sub: 'invented_user',
    profileId: 'other_profile', sessionId: 'invented_session', nbf: now / 1000 - 1,
    exp: now / 1000 + 300, scopes: ['recruiting.candidateSearch'] };
  assert.equal((await fetch(`${restartedBase}/hh/proactive?vacancy_id=${vacancyId}`,
    { headers: { cookie: session }, redirect: 'manual' })).status, 303);
  const wrongStart = await fetch(`${restartedBase}/auth/connected/start?from=proactive`, { redirect: 'manual' });
  const wrongPending = wrongStart.headers.getSetCookie().find(x => x.startsWith('__Host-recruiting-oauth-pending=')).split(';')[0];
  const wrongState = new URL(wrongStart.headers.get('location')).searchParams.get('state');
  const wrongCallback = await fetch(`${restartedBase}/auth/connected/callback?code=${'e'.repeat(64)}&state=${wrongState}&iss=${encodeURIComponent(issuer)}`,
    { redirect: 'manual', headers: { cookie: wrongPending } });
  const wrongSession = wrongCallback.headers.getSetCookie().find(x => x.startsWith('__Host-recruiting-app-session=')).split(';')[0];
  assert.equal((await fetch(`${restartedBase}/hh/proactive`, { headers: { cookie: wrongSession } })).status, 404);
  assert.equal((await fetch(`${restartedBase}/hh/proactive?vacancy_id=${vacancyId}`,
    { headers: { cookie: wrongSession } })).status, 404);
  assert.ok(sessionInfo.csrfToken);
});

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
