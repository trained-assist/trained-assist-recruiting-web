import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { createHash } from 'node:crypto';
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
const encryptionKey = 'a'.repeat(64);
const sealed = value => {
  const iv = Buffer.alloc(16, 3); const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([2]), iv, cipher.getAuthTag(), ciphertext]).toString('base64');
};
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
    const assignment = actor.profileId === 'profile_A'
      ? { vacancy_id: actor.vacancyId, test_task: 'Сохранённый пример <script> & ответ' }
      : { vacancy_id: actor.vacancyId, test_task: 'Прежний материал',
        communication_plan: { version: 1, stages: [{ id: 'approved_stage', title: 'Практическое задание',
          instruction: 'Передать точный текст', completion_result: 'Ответ получен',
          material: 'Проверенный пример для B', material_mode: 'verbatim' }] } };
    writeFileSync(join(contextDirectory, `ats_config:${actor.vacancyId}.json`),
      JSON.stringify({ value: assignment }), { mode: 0o600 });
    const proactiveDirectory = privateDir(`${actor.profileId}-proactive`);
    const tokenDirectory = privateDir(`${actor.profileId}-tokens`);
    writeFileSync(join(tokenDirectory, 'hh'), sealed({ access_token: actor.token,
      refresh_token: `refresh_${actor.profileId}` }), { mode: 0o600 });
    return { profileId: actor.profileId, legacyUsername: `legacy_${actor.profileId}`,
      vacancyIds: [actor.vacancyId], contextDirectory, proactiveDirectory, tokenDirectory };
  });
  for (const [name, value] of Object.entries({ hh_encryption_key: encryptionKey, hh_client_id: 'test-client',
    hh_client_secret: 'test-client-secret', hh_user_agent: 'Test Recruiting (contact@example.invalid)',
    ladder_token: 'test-ladder', cp_service_key: 'test-cp-service-key-32-characters-minimum',
    bff_encryption_key: 'b'.repeat(64) })) writeFileSync(join(secrets, name), value, { mode: 0o600 });
  const configFile = join(directory, 'config.json');
  writeFileSync(configFile, JSON.stringify({ version: 'r03-private-host-v1', dbPath: join(directory, 'state.sqlite'), profiles }), { mode: 0o600 });
  let actor = actors[0]; let scopes = ['recruiting.responses.read'];
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
        sessionId: 'session_A', scopes, nbf: now.getTime() / 1000 - 1,
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
      if (url.pathname.startsWith('/negotiations/n_')) {
        const id = decodeURIComponent(url.pathname.slice('/negotiations/'.length));
        const vacancyId = id.match(/^n_(vacancy_[AB])_0$/)?.[1] ?? actor.vacancyId;
        return { status: 200, ok: true, json: async () => ({ id, vacancy: { id: vacancyId },
          chat_id: 123456, resume: { id: 'resume_example' }, state: { id: 'response' },
          updated_at: '2026-10-06T07:10:00Z' }) };
      }
      if (url.pathname === '/common/chats/123456/messages') return { status: 200, ok: true,
        json: async () => ({ id: '123456', vacancy_id: actor.vacancyId, has_more: false,
          messages: [{ id: 'message_A', creation_time: '2026-10-06T07:00:00Z', type: 'SIMPLE',
            payload: { text: 'synthetic message' }, viewed_by_opponent: false }] }) };
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
  return { server, calls, profiles, setActor: value => { actor = value; }, setScope: value => { scopes = [value]; },
    setScopes: values => { scopes = values; },
    setCpOutage: value => { cpOutage = value; }, setHhOutage: value => { hhOutage = value; },
    setRefresh: value => { refresh = value; },
    get exchanges() { return exchanges; } };
}

test('exact response detail checks CP scope and owned vacancy without opening HH messages', async t => {
  const f = fixture(t); await once(f.server, 'listening');
  const base = `http://127.0.0.1:${f.server.address().port}`;
  f.setScope('recruiting.candidateSearch');
  const proactive = await signIn(base, 'proactive', 'vacancy_A');
  const restrictedApi = `${base}/api/v1/ui/hh-response-detail?vacancyId=vacancy_A&negotiationId=n_vacancy_A_0`;
  assert.equal((await fetch(restrictedApi, { headers: { cookie: proactive.session } })).status, 403);
  f.setScope('recruiting.responses.read');
  const login = await signIn(base, 'responses', 'vacancy_A');
  const headers = { cookie: login.session };
  const api = `${base}/api/v1/ui/hh-response-detail?vacancyId=vacancy_A&negotiationId=n_vacancy_A_0`;
  const detail = await fetch(api, { headers });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).state, 'response');
  const page = await fetch(`${base}/hh/response-detail?vacancy_id=vacancy_A&negotiation_id=n_vacancy_A_0`, { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Текущий статус HH: response/);
  assert.equal((await fetch(`${base}/api/v1/ui/hh-response-detail?vacancyId=vacancy_B&negotiationId=n_vacancy_B_0`,
    { headers })).status, 404);
  assert.equal((await fetch(`${api}&token=bad`, { headers })).status, 400);
  assert.equal((await fetch(api, { method: 'POST', headers })).status, 405);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.url.pathname === '/negotiations/n_vacancy_A_0'));
  f.setActor(actors[1]);
  assert.equal((await fetch(api, { headers })).status, 401);
  f.setActor(actors[0]); f.setCpOutage(true);
  assert.equal((await fetch(api, { headers })).status, 503);
  assert.equal(f.calls.length, 2);
});

async function signIn(base, from, vacancyId, negotiationId) {
  const start = await fetch(`${base}/auth/connected/start${from ? `?from=${from}${vacancyId ? `&vacancy_id=${vacancyId}` : ''}${negotiationId ? `&negotiation_id=${negotiationId}` : ''}` : ''}`,
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
  assert.equal(queryless.status, 200);
  assert.equal(queryless.headers.get('set-cookie'), null);
  const chooser = await queryless.text();
  assert.match(chooser, /href="\/auth\/connected\/start\?from=proactive"/);
  assert.match(chooser, /href="\/auth\/connected\/start\?from=responses"/);
  assert.doesNotMatch(chooser, /profile_A|hh_token_A|state=/);
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
  assert.match(html, /href="\/hh\/proactive\?vacancy_id=vacancy_A"/);
  assert.match(html, /href="\/hh\/assignment\?vacancy_id=vacancy_A"/);
  const assignment = await fetch(`${base}/api/v1/ui/vacancy-assignment?vacancyId=vacancy_A`,
    { headers: { cookie: login.session } });
  assert.equal(assignment.status, 200);
  const assignmentData = await assignment.json();
  assert.equal(assignmentData.reviewStatus, 'legacy_draft_requires_review');
  assert.equal(assignmentData.materials[0].material, 'Сохранённый пример <script> & ответ');
  assert.equal(assignmentData.materials[0].sha256,
    createHash('sha256').update('Сохранённый пример <script> & ответ').digest('hex'));
  assert.equal(assignment.headers.get('cache-control'), 'no-store');
  const assignmentPage = await fetch(`${base}/hh/assignment?vacancy_id=vacancy_A`,
    { headers: { cookie: login.session } });
  assert.equal(assignmentPage.status, 200);
  const assignmentHtml = await assignmentPage.text();
  assert.match(assignmentHtml, /Сохранённый пример &lt;script&gt; &amp; ответ/);
  assert.doesNotMatch(assignmentHtml, /id="assignment-review"/);
  assert.match(assignmentHtml, /from=assignment&amp;vacancy_id=vacancy_A/);
  assert.doesNotMatch(assignmentHtml, /<script>/);
  const assignmentApp = await fetch(`${base}/hh/assignment/app.js`, { headers: { cookie: login.session } });
  assert.equal(assignmentApp.status, 200);
  assert.equal(assignmentApp.headers.get('cache-control'), 'no-store');
  const assignmentAppSource = await assignmentApp.text();
  assert.match(assignmentAppSource, /\/auth\/connected\/session/);
  assert.match(assignmentAppSource, /x-csrf-token/);
  assert.match(assignmentAppSource, /recruiting\.assignment\.review/);
  assert.match(assignmentAppSource, /assignment-add-stage/);
  assert.equal((await fetch(`${base}/api/v1/ui/vacancy-assignment?vacancyId=vacancy_B`,
    { headers: { cookie: login.session } })).status, 404);
  assert.equal((await fetch(`${base}/hh/responses`, { headers: { cookie: login.session } })).status, 200);
  const back = await fetch(`${base}/hh/proactive?vacancy_id=vacancy_A`,
    { headers: { cookie: login.session }, redirect: 'manual' });
  assert.equal(back.status, 303);
  assert.equal(back.headers.get('location'), '/auth/connected/start?from=proactive&vacancy_id=vacancy_A');
  assert.equal((await fetch(`${base}/api/hh/proactive/candidates?vacancy_id=vacancy_A`,
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
  const savedAssignment = await fetch(`${base}/api/v1/ui/vacancy-assignment?vacancyId=vacancy_B`,
    { headers: { cookie: second.session } });
  assert.equal(savedAssignment.status, 200);
  const savedAssignmentData = await savedAssignment.json();
  assert.equal(savedAssignmentData.reviewStatus, 'saved_plan');
  assert.equal(savedAssignmentData.legacyConflict, true);
  assert.deepEqual(savedAssignmentData.materials.map(item => item.material), ['Проверенный пример для B']);
  assert.equal((await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`,
    { headers: { cookie: second.session } })).status, 404);
  f.setActor(actors[0]);
  assert.equal((await fetch(`${base}/hh/responses?vacancy_id=vacancy_A&token=bad`,
    { headers: { cookie: login.session } })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`,
    { method: 'POST', headers: { cookie: login.session } })).status, 405);
  assert.equal((await fetch(`${base}/api/v1/ui/vacancy-assignment?vacancyId=vacancy_A`,
    { method: 'POST', headers: { cookie: login.session } })).status, 401);
});

test('conversation history is a separate scoped POST with real BFF CSRF and exact confirmation path', async t => {
  const f = fixture(t); await once(f.server, 'listening');
  const base = `http://127.0.0.1:${f.server.address().port}`;
  const query = 'vacancy_id=vacancy_A&negotiation_id=n_vacancy_A_0';
  f.setScope('recruiting.responses.read');
  const readOnly = await signIn(base, 'responses', 'vacancy_A');
  const path = `${base}/hh/response-conversation?${query}`;
  const confirmation = await fetch(path, { headers: { cookie: readOnly.session } });
  assert.equal(confirmation.status, 200);
  assert.match(await confirmation.text(), /истории сообщений может отметить отклик просмотренным/);
  assert.equal(f.calls.length, 0, 'GET confirmation must not read HH messages');
  const readOnlySession = await (await fetch(`${base}/auth/connected/session`, { headers: { cookie: readOnly.session } })).json();
  const noEffectScope = await fetch(path, { method: 'POST', headers: { cookie: readOnly.session, origin, 'x-csrf-token': readOnlySession.csrfToken } });
  assert.equal(noEffectScope.status, 403);
  assert.equal(f.calls.length, 0, 'responses.read alone must not open HH chat');

  f.setScopes(['recruiting.responses.read', 'recruiting.responses.conversation.open']);
  const consent = await signIn(base, 'conversation', 'vacancy_A', 'n_vacancy_A_0');
  assert.equal(consent.authorize.searchParams.get('scope'), 'recruiting.responses.read recruiting.responses.conversation.open');
  assert.equal(consent.accepted.headers.get('location'), `${origin}/hh/response-conversation?${query}`);
  const appSession = cookie(consent.accepted, '__Host-recruiting-app-session');
  const session = await (await fetch(`${base}/auth/connected/session`, { headers: { cookie: appSession } })).json();
  const withoutCsrf = await fetch(path, { method: 'POST', headers: { cookie: appSession, origin } });
  assert.equal(withoutCsrf.status, 401);
  assert.equal(f.calls.length, 0, 'missing CSRF must prevent side effect');
  const opened = await fetch(path, { method: 'POST', headers: { cookie: appSession, origin,
    'x-csrf-token': session.csrfToken } });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).messages[0].text, 'synthetic message');
  assert.equal(f.calls.length, 2, 'one negotiation verification and one chat history request');
  assert.equal(f.calls[1].url.pathname, '/common/chats/123456/messages');
  assert.equal(f.calls[1].url.searchParams.get('limit'), '50');
});

test('reviewed assignment save is exact, immutable, profile-owned and fail-closed over HTTP', async t => {
  const f = fixture(t); await once(f.server, 'listening');
  const base = `http://127.0.0.1:${f.server.address().port}`;
  f.setScope('recruiting.assignment.review');
  const login = await signIn(base, 'assignment', 'vacancy_A');
  assert.equal(login.accepted.status, 303);
  assert.equal(login.authorize.searchParams.get('scope'), 'recruiting.assignment.review');
  const session = await fetch(`${base}/auth/connected/session`, { headers: { cookie: login.session } });
  const csrf = (await session.json()).csrfToken;
  const url = `${base}/api/v1/ui/vacancy-assignment?vacancyId=vacancy_A`;
  const before = await (await fetch(url, { headers: { cookie: login.session } })).json();
  assert.equal(before.reviewStatus, 'legacy_draft_requires_review');
  assert.equal(before.draftPlan.stages[0].material, before.materials[0].material);
  const page = await fetch(`${base}/hh/assignment?vacancy_id=vacancy_A`, { headers: { cookie: login.session } });
  assert.equal(page.status, 200);
  const form = await page.text();
  assert.match(form, /Сохранить проверенный сценарий/);
  assert.match(form, /Исходный дословный материал должен сохраниться/);
  assert.match(form, /data-source-sha256="[a-f0-9]{64}"/);
  assert.equal((await fetch(`${base}/hh/assignment/app.js`, { headers: { cookie: login.session } })).status, 200);
  const request = { sourceSha256: before.sourceSha256, plan: before.draftPlan, reviewed: true };
  const post = (payload = request, extra = {}) => fetch(url, { method: 'POST', body: JSON.stringify(payload),
    headers: { cookie: login.session, origin, 'x-csrf-token': csrf, 'content-type': 'application/json', ...extra } });
  assert.equal((await post(request, { 'x-csrf-token': 'wrong' })).status, 401);
  assert.equal((await post({ ...request, reviewed: false })).status, 400);
  assert.equal((await post({ ...request, sourceSha256: '0'.repeat(64) })).status, 409);
  const alteredMaterial = structuredClone(request);
  alteredMaterial.plan.stages[0].material = 'изменённый текст';
  assert.equal((await post(alteredMaterial)).status, 409, 'the exact imported source must remain in the reviewed plan');
  assert.equal((await fetch(`${base}/api/v1/ui/vacancy-assignment?vacancyId=vacancy_B`,
    { method: 'POST', body: JSON.stringify(request), headers: { cookie: login.session, origin,
      'x-csrf-token': csrf, 'content-type': 'application/json' } })).status, 404);
  f.setCpOutage(true);
  assert.equal((await post()).status, 503);
  f.setCpOutage(false);
  const saved = await post();
  assert.equal(saved.status, 201);
  const receipt = await saved.json();
  assert.match(receipt.revisionSha256, /^[a-f0-9]{64}$/);
  assert.equal((await post()).status, 200);
  const changed = structuredClone(request); changed.plan.stages[0].instruction = 'Изменённая инструкция';
  assert.equal((await post(changed)).status, 409);
  const after = await (await fetch(url, { headers: { cookie: login.session } })).json();
  assert.equal(after.reviewStatus, 'saved_plan');
  assert.equal(after.planRevisionSha256, receipt.revisionSha256);
  assert.equal(after.materials[0].material, before.materials[0].material);
  assert.equal(f.calls.length, 0);
  const sidecar = join(f.profiles[0].contextDirectory, 'ats_communication_plan:vacancy_A.json');
  assert.equal((await import('node:fs')).statSync(sidecar).mode & 0o077, 0);
});

test('response BFF denies missing scope/profile switch and outages; refreshes once', async t => {
  const f = fixture(t); await once(f.server, 'listening');
  const base = `http://127.0.0.1:${f.server.address().port}`;
  f.setScope('recruiting.candidateSearch');
  const candidateOnly = await signIn(base, 'proactive', null);
  assert.equal(candidateOnly.accepted.status, 303);
  const stepUp = await fetch(`${base}/hh/responses?vacancy_id=vacancy_A`,
    { headers: { cookie: candidateOnly.session }, redirect: 'manual' });
  assert.equal(stepUp.status, 303);
  assert.equal(stepUp.headers.get('location'), '/auth/connected/start?from=responses&vacancy_id=vacancy_A');
  assert.equal((await fetch(`${base}/api/v1/ui/hh-responses?vacancyId=vacancy_A`,
    { headers: { cookie: candidateOnly.session } })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/ui/vacancy-assignment?vacancyId=vacancy_A`,
    { headers: { cookie: candidateOnly.session } })).status, 403);
  const denied = await signIn(base, 'responses', 'vacancy_A');
  assert.equal(denied.accepted.status, 403);
  assert.deepEqual(await denied.accepted.json(), { error: 'connected_app_scope_denied' });
  assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=vacancy_A`, { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=vacancy_A`,
    { headers: { cookie: candidateOnly.session } })).status, 200);
  const proactivePage = await (await fetch(`${base}/hh/proactive?vacancy_id=vacancy_A`,
    { headers: { cookie: candidateOnly.session } })).text();
  assert.match(proactivePage, /href="\/hh\/responses\?vacancy_id=vacancy_A"/);
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
  assert.equal((await fetch(`${base}/api/v1/ui/vacancy-assignment?vacancyId=vacancy_A`,
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
