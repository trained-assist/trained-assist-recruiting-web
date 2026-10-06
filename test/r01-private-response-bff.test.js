import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateWebRuntime } from '../src/r03-private-web-runtime.js';

const issuer = 'https://cp.example.invalid';
const origin = 'https://recruiter-assistant.ru';
const now = new Date('2026-10-06T08:00:00.000Z');
const actors = [{ profileId: 'profile_A', vacancyId: 'vacancy_A', token: 'hh_token_A' },
  { profileId: 'profile_B', vacancyId: 'vacancy_B', token: 'hh_token_B' }];
const cookie = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(';')[0];
const hhPage = (vacancyId, page = 0) => ({ items: [{ id: `n_${vacancyId}_${page}`, state: { id: 'response' },
  vacancy: { id: vacancyId }, resume: { id: `r_${vacancyId}_${page}`, first_name: '<Recruiter>',
    last_name: 'Candidate', title: 'Engineer' }, created_at: '2026-10-06T07:00:00Z' }],
  found: 21, pages: 2, page });

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'r01-connected-read-')));
  chmodSync(directory, 0o700);
  const privateDir = name => { const path = join(directory, name); mkdirSync(path, { mode: 0o700 }); return path; };
  const secrets = privateDir('secrets');
  const profiles = actors.map(actor => {
    const contextDirectory = privateDir(`${actor.profileId}-context`);
    const proactiveDirectory = privateDir(`${actor.profileId}-proactive`);
    const tokenDirectory = privateDir(`${actor.profileId}-tokens`);
    writeFileSync(join(tokenDirectory, 'hh'), JSON.stringify({ access_token: actor.token,
      refresh_token: `refresh_${actor.profileId}` }), { mode: 0o600 });
    return { profileId: actor.profileId, legacyUsername: `legacy_${actor.profileId}`,
      vacancyIds: [actor.vacancyId], contextDirectory, proactiveDirectory, tokenDirectory };
  });
  for (const [name, value] of Object.entries({ hh_encryption_key: 'a'.repeat(64), hh_client_id: 'test-client',
    hh_client_secret: 'test-client-secret', hh_user_agent: 'Test Recruiting (contact@example.invalid)',
    ladder_token: 'test-ladder', cp_service_key: 'test-cp-service-key-32-characters-minimum',
    bff_encryption_key: 'b'.repeat(64) })) writeFileSync(join(secrets, name), value, { mode: 0o600 });
  const configFile = join(directory, 'config.json');
  writeFileSync(configFile, JSON.stringify({ version: 'r03-private-host-v1', dbPath: join(directory, 'state.sqlite'), profiles }), { mode: 0o600 });
  let actor = actors[0]; let scope = 'recruiting.responses.read';
  let cpOutage = false; let hhOutage = false; let refresh = false;
  const calls = []; let exchanges = 0;
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    if (url.origin === issuer) {
      if (cpOutage) throw new Error('CP unavailable');
      if (url.pathname.endsWith('/exchange')) {
        exchanges++;
        return { ok: true, json: async () => ({ token: 'c'.repeat(64), expiresAt: now.getTime() / 1000 + 300 }) };
      }
      if (url.pathname.endsWith('/introspect')) return { ok: true, json: async () => ({ active: true,
        iss: issuer, aud: 'recruiting-web', sub: 'user_A', profileId: actor.profileId,
        sessionId: 'session_A', scopes: [scope], nbf: now.getTime() / 1000 - 1,
        exp: now.getTime() / 1000 + 300 }) };
    }
    if (url.href === 'https://hh.ru/oauth/token') {
      assert.equal(options.method, 'POST');
      return { ok: true, json: async () => ({ access_token: `renewed_${actor.profileId}` }) };
    }
    if (url.origin === 'https://api.hh.ru') {
      calls.push({ url, options });
      if (hhOutage) throw new Error('HH unavailable');
      if (refresh && options.headers.authorization === `Bearer ${actor.token}`)
        return { status: 401, ok: false };
      const requested = url.searchParams.get('vacancy_id');
      const page = Number(url.searchParams.get('page'));
      return { status: 200, ok: true, json: async () => hhPage(requested, page) };
    }
    throw new Error('unexpected external port');
  };
  const server = createPrivateWebRuntime({ configFile, secretsDirectory: secrets, fetchImpl,
    clock: () => now, publicOrigin: origin,
    connectedBffConfig: { issuer, publicOrigin: origin, dbPath: join(directory, 'bff.sqlite') } });
  server.listen(0, '127.0.0.1');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return { server, calls, setActor: value => { actor = value; }, setScope: value => { scope = value; },
    setCpOutage: value => { cpOutage = value; }, setHhOutage: value => { hhOutage = value; },
    setRefresh: value => { refresh = value; },
    get exchanges() { return exchanges; } };
}

async function signIn(base, from, vacancyId) {
  const start = await fetch(`${base}/auth/connected/start${from ? `?from=${from}${vacancyId ? `&vacancy_id=${vacancyId}` : ''}` : ''}`,
    { redirect: 'manual' });
  assert.equal(start.status, 303);
  const authorize = new URL(start.headers.get('location'));
  const pending = cookie(start, '__Host-recruiting-oauth-pending');
  const callback = `${base}/auth/connected/callback?code=${'d'.repeat(64)}&state=${authorize.searchParams.get('state')}&iss=${encodeURIComponent(issuer)}`;
  const accepted = await fetch(callback, { redirect: 'manual', headers: { cookie: pending } });
  return { authorize, accepted, callback, pending, session: cookie(accepted, '__Host-recruiting-app-session') };
}

test('private response entry requests one step-up scope, real HTTP reader and owned HH page', async t => {
  const f = fixture(t); await once(f.server, 'listening');
  const base = `http://127.0.0.1:${f.server.address().port}`;
  const queryless = await fetch(`${base}/auth/connected/start`, { redirect: 'manual' });
  assert.equal(new URL(queryless.headers.get('location')).searchParams.get('scope'), 'recruiting.candidateSearch');
  const entrance = await fetch(`${base}/hh/responses?vacancy_id=vacancy_A`, { redirect: 'manual' });
  assert.equal(entrance.status, 303);
  assert.equal(entrance.headers.get('location'), '/auth/connected/start?from=responses&vacancy_id=vacancy_A');
  const login = await signIn(base, 'responses', 'vacancy_A');
  assert.equal(login.authorize.searchParams.get('scope'), 'recruiting.responses.read');
  assert.equal(login.accepted.headers.get('location'), `${origin}/hh/responses?vacancy_id=vacancy_A`);
  assert.equal((await fetch(login.callback, { redirect: 'manual', headers: { cookie: login.pending } })).status, 401);
  const api = await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`, { headers: { cookie: login.session } });
  assert.equal(api.status, 200);
  assert.equal((await api.json()).items[0].resumeId, 'r_vacancy_A_0');
  const page = await fetch(`${base}/hh/responses?vacancy_id=vacancy_A&page=1`, { headers: { cookie: login.session } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /r_vacancy_A_1|&lt;Recruiter&gt;/);
  assert.doesNotMatch(html, /<Recruiter>/);
  assert.match(html, /Страницы могут измениться/);
  assert.equal((await fetch(`${base}/hh/responses`, { headers: { cookie: login.session } })).status, 200);
  assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=vacancy_A`,
    { headers: { cookie: login.session } })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_B`,
    { headers: { cookie: login.session } })).status, 404);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.url.searchParams.get('vacancy_id') === 'vacancy_A'));
  assert.ok(f.calls.every(call => call.options.headers.authorization === 'Bearer hh_token_A'));
  f.setActor(actors[1]);
  const second = await signIn(base, 'responses', 'vacancy_B');
  assert.equal(second.accepted.status, 303);
  const secondRead = await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_B`,
    { headers: { cookie: second.session } });
  assert.equal(secondRead.status, 200);
  assert.equal(f.calls.at(-1).options.headers.authorization, 'Bearer hh_token_B');
  assert.equal((await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`,
    { headers: { cookie: second.session } })).status, 404);
  f.setActor(actors[0]);
  assert.equal((await fetch(`${base}/hh/responses?vacancy_id=vacancy_A&token=bad`,
    { headers: { cookie: login.session } })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`,
    { method: 'POST', headers: { cookie: login.session } })).status, 405);
});

test('response BFF denies missing scope/profile switch and outages; refreshes once', async t => {
  const f = fixture(t); await once(f.server, 'listening');
  const base = `http://127.0.0.1:${f.server.address().port}`;
  f.setScope('recruiting.candidateSearch');
  const candidateOnly = await signIn(base, null, null);
  assert.equal(candidateOnly.accepted.status, 303);
  const stepUp = await fetch(`${base}/hh/responses?vacancy_id=vacancy_A`,
    { headers: { cookie: candidateOnly.session }, redirect: 'manual' });
  assert.equal(stepUp.status, 303);
  assert.equal(stepUp.headers.get('location'), '/auth/connected/start?from=responses&vacancy_id=vacancy_A');
  assert.equal((await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`,
    { headers: { cookie: candidateOnly.session } })).status, 403);
  const denied = await signIn(base, 'responses', 'vacancy_A');
  assert.equal(denied.accepted.status, 403);
  assert.deepEqual(await denied.accepted.json(), { error: 'connected_app_scope_denied' });
  assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=vacancy_A`, { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=vacancy_A`,
    { headers: { cookie: candidateOnly.session } })).status, 200);
  f.setScope('recruiting.responses.read');
  const login = await signIn(base, 'responses', 'vacancy_A');
  assert.equal(login.accepted.status, 303);
  f.setRefresh(true);
  const read = await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`, { headers: { cookie: login.session } });
  assert.equal(read.status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.headers.authorization, 'Bearer renewed_profile_A');
  f.setActor(actors[1]);
  assert.equal((await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`,
    { headers: { cookie: login.session } })).status, 401);
  f.setActor(actors[0]);
  f.setCpOutage(true);
  assert.equal((await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`,
    { headers: { cookie: login.session } })).status, 503);
  assert.equal(f.calls.length, 2);
  f.setCpOutage(false);
  f.setHhOutage(true);
  const providerFailure = await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`,
    { headers: { cookie: login.session } });
  assert.equal(providerFailure.status, 503);
  assert.deepEqual(await providerFailure.json(), { error: 'hh_provider_unavailable' });
  assert.equal(f.exchanges, 3);
});
