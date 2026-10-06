import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRecruitingServer } from '../src/server.js';
import { createControlPlaneConnectedAppClient, createMemoryConnectedAppBffStore,
  createRecruitingConnectedAppBff } from '../src/connected-app-bff.js';

const issuer = 'https://control.example.invalid';
const publicOrigin = 'https://recruiting.example.invalid';
const redirectUri = `${publicOrigin}/auth/connected/callback`;
const token = 'a'.repeat(64);
const now = Date.parse('2026-10-06T10:00:00Z');
const claims = { active: true, iss: issuer, aud: 'recruiting-web', sub: 'user_demo_001',
  profileId: 'profile_demo_001', sessionId: 'session_demo_001', nbf: now / 1000 - 1,
  exp: now / 1000 + 300, scopes: ['recruiting.responses.read'] };

async function fixture(t, approvalClient = null) {
  let current = { ...claims };
  let exchangeCalls = 0;
  let readCalls = 0;
  const bff = createRecruitingConnectedAppBff({ issuer, allowedIssuerOrigins: [issuer], publicOrigin, redirectUri,
    store: createMemoryConnectedAppBffStore(), clock: () => now,
    exchangeCode: async ({ code, state, verifier, redirectUri: callback }) => {
      exchangeCalls++;
      assert.match(code, /^[a-f0-9]{64}$/);
      assert.ok(state.length >= 32);
      assert.ok(verifier.length >= 43);
      assert.equal(callback, redirectUri);
      return { token, expiresAt: now / 1000 + 300 };
    },
    introspectToken: async offered => offered === token ? current : { active: false }, approvalClient,
    scopes: ['recruiting.responses.read'] });
  const server = createRecruitingServer({ connectedAppBff: bff,
    liveResponseRead: async context => { readCalls++; return { status: 200, body: { profileId: context.profileId } }; },
    acceptedReportSourceRead: async () => { throw new Error('scope should deny report source'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, setClaims: value => { current = value; },
    get exchangeCalls() { return exchangeCalls; }, get readCalls() { return readCalls; }, bff };
}
const getCookie = (response, name) => response.headers.getSetCookie().find(part => part.startsWith(`${name}=`))?.split(';')[0];
async function start(base, from = 'responses', vacancyId = null, negotiationId = null) {
  const url = new URL(`${base}/auth/connected/start`); url.searchParams.set('from', from);
  if (vacancyId !== null) url.searchParams.set('vacancy_id', vacancyId);
  if (negotiationId !== null) url.searchParams.set('negotiation_id', negotiationId);
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 303);
  const authorize = new URL(response.headers.get('location'));
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${issuer}/v1/connected-app-sessions/authorize`);
  assert.equal(authorize.searchParams.get('client_id'), 'recruiting-web');
  assert.equal(authorize.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorize.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  return { authorize, pendingCookie: getCookie(response, '__Host-recruiting-oauth-pending') };
}
async function callback(base, state, pendingCookie, params = {}) {
  const url = new URL(`${base}/auth/connected/callback`);
  url.searchParams.set('code', params.code ?? 'b'.repeat(64));
  url.searchParams.set('state', params.state ?? state);
  url.searchParams.set('iss', params.iss ?? issuer);
  return fetch(url, { redirect: 'manual', headers: { cookie: [pendingCookie, params.previousCookie].filter(Boolean).join('; ') } });
}

test('BFF exchanges one code and stores token only on the server', async t => {
  const f = await fixture(t);
  const { authorize, pendingCookie } = await start(f.base);
  const response = await callback(f.base, authorize.searchParams.get('state'), pendingCookie);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), `${publicOrigin}/hh/responses`);
  assert.equal(f.exchangeCalls, 1);
  const appCookie = getCookie(response, '__Host-recruiting-app-session');
  assert.ok(appCookie);
  assert.equal(appCookie.includes(token), false);
  assert.match(response.headers.getSetCookie().join(' '), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await response.text()).includes(token), false);
  const info = await fetch(`${f.base}/auth/connected/session`, { headers: { cookie: appCookie } });
  assert.equal(info.status, 200);
  const visible = await info.json();
  assert.equal(visible.profileId, 'profile_demo_001');
  assert.equal(JSON.stringify(visible).includes(token), false);
  assert.match(visible.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  const read = await fetch(`${f.base}/api/v1/ui/hh-responses?vacancyId=vac_demo_001`, { headers: { cookie: appCookie } });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).profileId, 'profile_demo_001');
  assert.equal((await fetch(`${f.base}/api/v1/ui/accepted-report-source?vacancyId=vac_demo_001&candidateId=candidate_demo_001`,
    { headers: { cookie: appCookie } })).status, 403);
  assert.equal(f.readCalls, 1);
  assert.equal((await callback(f.base, authorize.searchParams.get('state'), pendingCookie)).status, 401);
  assert.equal(f.exchangeCalls, 1);
  const second = await start(f.base);
  const rotated = await callback(f.base, second.authorize.searchParams.get('state'), second.pendingCookie,
    { previousCookie: appCookie });
  assert.equal(rotated.status, 303);
  const newCookie = getCookie(rotated, '__Host-recruiting-app-session');
  assert.notEqual(newCookie, appCookie);
  assert.equal((await fetch(`${f.base}/auth/connected/session`, { headers: { cookie: appCookie } })).status, 401);
  assert.equal((await fetch(`${f.base}/auth/connected/session`, { headers: { cookie: newCookie } })).status, 200);
});

test('callback rejects state and issuer mismatch before token exchange', async t => {
  const f = await fixture(t);
  let started = await start(f.base);
  assert.equal((await callback(f.base, started.authorize.searchParams.get('state'), started.pendingCookie,
    { state: 'attacker-state' })).status, 401);
  assert.equal(f.exchangeCalls, 0);
  assert.equal((await fetch(`${f.base}/auth/connected/start?returnTo=https://evil.example.invalid`,
    { redirect: 'manual' })).status, 400);
  assert.equal((await fetch(`${f.base}/auth/connected/start?from=proactive&vacancy_id=../../evil`,
    { redirect: 'manual' })).status, 400);
  started = await start(f.base);
  const target = new URL(`${f.base}/auth/connected/callback`);
  target.searchParams.set('code', 'b'.repeat(64));
  target.searchParams.set('state', started.authorize.searchParams.get('state'));
  target.searchParams.set('iss', issuer);
  target.searchParams.set('returnTo', 'https://evil.example.invalid');
  assert.equal((await fetch(target, { redirect: 'manual', headers: { cookie: started.pendingCookie } })).status, 401);
  assert.equal(f.exchangeCalls, 0);
  started = await start(f.base);
  assert.equal((await callback(f.base, started.authorize.searchParams.get('state'), started.pendingCookie,
    { iss: 'https://wrong.example.invalid' })).status, 401);
  assert.equal(f.exchangeCalls, 0);
});

test('BFF contains no token/code logging path', async () => {
  const source = await readFile(new URL('../src/connected-app-bff.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bconsole\./);
});

test('CSRF and current introspection gate browser requests, then logout clears local session', async t => {
  const f = await fixture(t);
  const { authorize, pendingCookie } = await start(f.base);
  const response = await callback(f.base, authorize.searchParams.get('state'), pendingCookie);
  const appCookie = getCookie(response, '__Host-recruiting-app-session');
  const info = await (await fetch(`${f.base}/auth/connected/session`, { headers: { cookie: appCookie } })).json();
  const logout = headers => fetch(`${f.base}/auth/connected/logout`, { method: 'POST', headers: { cookie: appCookie, ...headers } });
  assert.equal((await logout({})).status, 403);
  assert.equal((await logout({ origin: 'https://evil.example.invalid', 'x-csrf-token': info.csrfToken })).status, 403);
  assert.equal((await logout({ origin: publicOrigin, 'x-csrf-token': 'wrong' })).status, 403);
  f.setClaims({ active: false });
  assert.equal((await fetch(`${f.base}/api/v1/ui/hh-responses?vacancyId=vac_demo_001`,
    { headers: { cookie: appCookie } })).status, 401);
  assert.equal(f.readCalls, 0);
  f.setClaims(null);
  const unavailableRead = await fetch(`${f.base}/api/v1/ui/hh-responses?vacancyId=vac_demo_001`,
    { headers: { cookie: appCookie } });
  assert.equal(unavailableRead.status, 503);
  assert.deepEqual(await unavailableRead.json(), { error: 'connected_app_introspection_unavailable' });
  const unavailableSession = await fetch(`${f.base}/auth/connected/session`, { headers: { cookie: appCookie } });
  assert.equal(unavailableSession.status, 503);
  assert.deepEqual(await unavailableSession.json(), { error: 'connected_app_introspection_unavailable' });
  assert.equal((await logout({ origin: publicOrigin, 'x-csrf-token': info.csrfToken })).status, 204);
  assert.equal((await fetch(`${f.base}/auth/connected/session`, { headers: { cookie: appCookie } })).status, 401);
});

test('BFF refuses claims from another issuer, audience or profile scope', async t => {
  const f = await fixture(t);
  const { authorize, pendingCookie } = await start(f.base);
  const response = await callback(f.base, authorize.searchParams.get('state'), pendingCookie);
  const appCookie = getCookie(response, '__Host-recruiting-app-session');
  for (const changed of [{ ...claims, iss: 'https://wrong.example.invalid' },
    { ...claims, aud: 'crm-web' }, { ...claims, scopes: ['recruiting.candidateSearch'] },
    { ...claims, profileId: 'profile_demo_002' }, { ...claims, sessionId: 'session_demo_002' },
    { ...claims, exp: now / 1000 }]) {
    f.setClaims(changed);
    assert.equal((await fetch(`${f.base}/api/v1/ui/hh-responses?vacancyId=vac_demo_001`,
      { headers: { cookie: appCookie } })).status, 401);
  }
  assert.equal(f.readCalls, 0);
});

test('private proactive routes use the same BFF profile and command CSRF gate', async t => {
  let current = { ...claims, scopes: ['recruiting.candidateSearch'] };
  let reads = 0; let commands = 0;
  const bff = createRecruitingConnectedAppBff({ issuer, allowedIssuerOrigins: [issuer], publicOrigin, redirectUri,
    store: createMemoryConnectedAppBffStore(), clock: () => now,
    exchangeCode: async () => ({ token, expiresAt: now / 1000 + 300 }),
    introspectToken: async () => current, scopes: ['recruiting.candidateSearch'] });
  const server = createRecruitingServer({ connectedAppBff: bff, privateProactiveOnly: true,
    realProactiveFeed: { read: () => { reads++; return { status: 'completed', freshness: 'latest_completed',
      total: 0, resultRevision: 'synthetic_revision_1', items: [] }; } },
    realProactiveActions: { manualStart: async () => { commands++; return { status: 200, body: { ok: true } }; } },
    resolveRealVacancyOwnership: (context, vacancy) => context.profileId === claims.profileId && vacancy === 'vac_demo_001' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const candidateUrl = `${base}/api/hh/proactive/candidates?vacancy_id=vac_demo_001`;
  assert.equal((await fetch(candidateUrl)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/vacancies`)).status, 404, 'private mode hides synthetic routes');
  const { authorize, pendingCookie } = await start(base, 'proactive');
  assert.equal(authorize.searchParams.get('scope'), 'recruiting.candidateSearch');
  const login = await callback(base, authorize.searchParams.get('state'), pendingCookie);
  assert.equal(login.status, 303);
  const appCookie = getCookie(login, '__Host-recruiting-app-session');
  const session = await (await fetch(`${base}/auth/connected/session`, { headers: { cookie: appCookie } })).json();
  assert.equal((await fetch(candidateUrl, { headers: { cookie: appCookie } })).status, 200);
  assert.equal((await fetch(`${base}/hh/proactive?vacancy_id=vac_demo_001&username=old&token=deadbeef`,
    { headers: { cookie: appCookie } })).status, 400, 'BFF mode does not accept legacy link selectors');
  assert.equal(reads, 1);
  const commandUrl = `${base}/api/hh/proactive/search`;
  const request = headers => fetch(commandUrl, { method: 'POST', headers: { cookie: appCookie,
    'content-type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await request({})).status, 401);
  assert.equal((await request({ origin: 'https://wrong.example.invalid', 'x-csrf-token': session.csrfToken })).status, 401);
  assert.equal(commands, 0);
  assert.equal((await request({ origin: publicOrigin, 'x-csrf-token': session.csrfToken })).status, 200);
  assert.equal(commands, 1);
  current = { ...current, profileId: 'profile_demo_002' };
  assert.equal((await fetch(candidateUrl, { headers: { cookie: appCookie } })).status, 401);
  assert.equal(reads, 1, 'a switched profile cannot reuse the old browser session for candidate reads');
  current = null;
  assert.equal((await fetch(candidateUrl, { headers: { cookie: appCookie } })).status, 503);
  assert.equal(reads, 1);
});

test('PKCE challenge generated by BFF corresponds to the server-side verifier', async t => {
  let captured;
  const store = createMemoryConnectedAppBffStore();
  const original = store.putPending;
  store.putPending = async (key, value) => { captured = value; return original(key, value); };
  const bff = createRecruitingConnectedAppBff({ issuer, allowedIssuerOrigins: [issuer], publicOrigin, redirectUri, store,
    exchangeCode: async () => null, introspectToken: async () => null });
  const server = createRecruitingServer({ connectedAppBff: bff });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { authorize } = await start(`http://127.0.0.1:${server.address().port}`);
  assert.equal(authorize.searchParams.get('code_challenge'),
    createHash('sha256').update(captured.verifier).digest('base64url'));
});

test('default BFF accepts its explicit proactive mode without custom scope configuration', async t => {
  const bff = createRecruitingConnectedAppBff({ issuer, allowedIssuerOrigins: [issuer], publicOrigin,
    redirectUri, store: createMemoryConnectedAppBffStore(), clock: () => now,
    exchangeCode: async () => ({ token, expiresAt: now / 1000 + 300 }),
    introspectToken: async () => ({ ...claims, scopes: ['recruiting.candidateSearch'] }) });
  const server = createRecruitingServer({ connectedAppBff: bff });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { authorize, pendingCookie } = await start(base, 'proactive');
  assert.equal(authorize.searchParams.get('scope'), 'recruiting.candidateSearch');
  const result = await callback(base, authorize.searchParams.get('state'), pendingCookie);
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), `${publicOrigin}/hh/proactive`);
});

test('CP client exchanges code and introspects with its server-side service credential', async () => {
  const calls = [];
  const client = createControlPlaneConnectedAppClient({ issuer, allowedIssuerOrigins: [issuer],
    serviceKey: 'app-service-secret-at-least-thirty-two-characters',
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(url.endsWith('/exchange')
        ? { token, expiresAt: now / 1000 + 300 } : claims), { status: 200 });
    } });
  assert.equal((await client.exchangeCode({ code: 'b'.repeat(64), state: 's'.repeat(43),
    verifier: 'v'.repeat(43), redirectUri })).token, token);
  assert.equal((await client.introspectToken(token)).profileId, claims.profileId);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${issuer}/v1/connected-app-sessions/exchange`);
  assert.equal(calls[0].options.body.get('code_verifier'), 'v'.repeat(43));
  assert.equal(calls[0].options.body.get('client_id'), 'recruiting-web');
  assert.deepEqual(JSON.parse(calls[1].options.body), { token, audience: 'recruiting-web' });
  assert.ok(calls.every(call => call.options.redirect === 'manual'));
  assert.ok(calls.every(call => call.options.headers.authorization.startsWith('Bearer app-service-secret-')));
  assert.throws(() => createControlPlaneConnectedAppClient({ issuer, allowedIssuerOrigins: ['https://wrong.example.invalid'],
    serviceKey: 'app-service-secret-at-least-thirty-two-characters', fetcher: async () => { throw Error('must not call'); } }),
  /configuration_required/);
  const unavailable = createControlPlaneConnectedAppClient({ issuer, allowedIssuerOrigins: [issuer],
    serviceKey: 'app-service-secret-at-least-thirty-two-characters',
    fetcher: async () => new Response(null, { status: 503 }) });
  await assert.rejects(() => unavailable.introspectToken(token), /connected_app_introspection_unavailable/);
});

test('CP approval client sends exact prepare/consume payloads with server credential and rejects redirects', async () => {
  const calls = [];
  const client = createControlPlaneConnectedAppClient({ issuer, allowedIssuerOrigins: [issuer],
    serviceKey: 'app-service-secret-at-least-thirty-two-characters', fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(url.endsWith('/prepare')
        ? { intentId: 'd'.repeat(64), approvalUrl: `${issuer}/v1/connected-app-approvals/review?intent=${'d'.repeat(64)}`, expiresAt: now / 1000 + 300 }
        : { version: 1, receipt: { receiptId: 'c'.repeat(64) } }), { status: 201 });
    } });
  const operation = { vacancyId: 'vac_demo_001', negotiationId: 'neg_demo_001', chatId: 'chat_demo_001',
    sourceSha256: 'a'.repeat(64), savedPlanRevisionSha256: 'b'.repeat(64), materialSha256: 'c'.repeat(64),
    agreementMessageId: 'msg_agreement_001', message: 'Exact message' };
  const prepared = await client.prepareApproval({ appToken: token, command: 'recruiting.assignment.material.send',
    sourceRevision: 'b'.repeat(64), operation });
  assert.equal(prepared.intentId, 'd'.repeat(64));
  const consumed = await client.consumeApproval({ appToken: token, command: 'recruiting.assignment.material.send',
    sourceRevision: 'b'.repeat(64), operation, intentId: 'd'.repeat(64), consumerRequestId: 'request_A' });
  assert.equal(consumed.receipt.receiptId, 'c'.repeat(64));
  assert.deepEqual(calls.map(call => call.url), [
    `${issuer}/v1/connected-app-approvals/prepare`, `${issuer}/v1/connected-app-approvals/consume`]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { appToken: token, audience: 'recruiting-web',
    command: 'recruiting.assignment.material.send', sourceRevision: 'b'.repeat(64), operation });
  assert.equal(JSON.parse(calls[1].options.body).consumerRequestId, 'request_A');
  assert.ok(calls.every(call => call.options.headers.authorization.startsWith('Bearer app-service-secret-')));
  assert.ok(calls.every(call => call.options.redirect === 'manual'));
  const redirected = createControlPlaneConnectedAppClient({ issuer, allowedIssuerOrigins: [issuer],
    serviceKey: 'app-service-secret-at-least-thirty-two-characters',
    fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } }) });
  await assert.rejects(() => redirected.prepareApproval({ appToken: token,
    command: 'recruiting.assignment.material.send', sourceRevision: 'b'.repeat(64), operation }),
  /connected_app_approval_unavailable/);
});

test('CP assignment approval round trip keeps app token server-side and binds one pending handle to session/profile', async t => {
  const op = { profileId: claims.profileId, vacancyId: 'vac_demo_001', negotiationId: 'neg_demo_001',
    chatId: 'chat_demo_001', agreementMessageId: 'msg_agreement_001', sourceSha256: 'a'.repeat(64),
    savedPlanRevisionSha256: 'b'.repeat(64), message: 'Exact approved task',
    materialSha256: createHash('sha256').update('Exact approved task').digest('hex') };
  const cpOperation = { vacancyId: op.vacancyId, negotiationId: op.negotiationId, chatId: op.chatId,
    sourceSha256: op.sourceSha256, savedPlanRevisionSha256: op.savedPlanRevisionSha256,
    materialSha256: op.materialSha256, agreementMessageId: op.agreementMessageId, message: op.message };
  const canonical = Object.fromEntries(Object.entries(cpOperation).sort(([a], [b]) => a.localeCompare(b)));
  const requestHash = createHash('sha256').update(JSON.stringify({ audience: 'recruiting-web', clientId: 'recruiting-web',
    commandId: 'recruiting.assignment.material.send', operation: canonical,
    sourceRevision: op.savedPlanRevisionSha256 })).digest('hex');
  const receipt = { receiptId: 'c'.repeat(64), audience: 'recruiting-web', clientId: 'recruiting-web',
    command: 'recruiting.assignment.material.send', requestHash, sourceRevision: op.savedPlanRevisionSha256,
    principalId: claims.sub, profileId: claims.profileId, approvedAt: now / 1000 - 1,
    consumedAt: now / 1000, operation: cpOperation };
  const calls = [];
  const approvalClient = {
    async prepareApproval(input) { calls.push({ kind: 'prepare', input }); return {
      intentId: 'd'.repeat(64), approvalUrl: `${issuer}/v1/connected-app-approvals/review?intent=${'d'.repeat(64)}`,
      expiresAt: now / 1000 + 300 }; },
    async consumeApproval(input) { calls.push({ kind: 'consume', input }); return { version: 1, receipt }; }
  };
  const f = await fixture(t, approvalClient);
  f.setClaims({ ...claims, scopes: ['recruiting.assignment.material.send', 'recruiting.responses.conversation.open'] });
  const { authorize, pendingCookie } = await start(f.base, 'assignment-send', 'vac_demo_001', 'neg_demo_001');
  assert.equal(authorize.searchParams.get('scope'),
    'recruiting.assignment.material.send recruiting.responses.conversation.open');
  const login = await callback(f.base, authorize.searchParams.get('state'), pendingCookie);
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), `${publicOrigin}/hh/assignment/send?vacancy_id=vac_demo_001&negotiation_id=neg_demo_001`);
  const appCookie = getCookie(login, '__Host-recruiting-app-session');
  const visible = await (await fetch(`${f.base}/auth/connected/session`, { headers: { cookie: appCookie } })).json();
  const req = { method: 'POST', headers: { cookie: appCookie, origin: publicOrigin, 'x-csrf-token': visible.csrfToken } };
  const missingCsrf = await f.bff.prepareApprovalIntent({ method: 'POST', headers: { cookie: appCookie, origin: publicOrigin } }, op);
  assert.equal(missingCsrf.status, 401);
  assert.equal(calls.length, 0, 'missing CSRF never creates a CP approval intent');
  const prepared = await f.bff.prepareApprovalIntent(req, op);
  assert.equal(prepared.status, 201);
  assert.match(prepared.body.approvalHandle, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(prepared.body.approvalUrl, `${issuer}/v1/connected-app-approvals/review?intent=${'d'.repeat(64)}`);
  assert.equal(JSON.stringify(prepared).includes(token), false);
  assert.equal(calls[0].input.appToken, token, 'CP receives app token only from server BFF state');
  assert.deepEqual(calls[0].input.operation, cpOperation);
  const consumed = await f.bff.consumeApprovalIntent(req, prepared.body.approvalHandle);
  assert.deepEqual(consumed, { status: 200, body: { receipt } });
  assert.equal(calls[1].input.intentId, 'd'.repeat(64));
  assert.match(calls[1].input.consumerRequestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls[1].input.operation, cpOperation);
  assert.deepEqual(await f.bff.consumeApprovalIntent(req, prepared.body.approvalHandle), consumed);
  assert.equal(calls.filter(call => call.kind === 'consume').length, 1, 'local receipt recovery is stable');
  const switched = { ...claims, profileId: 'profile_other_003', scopes: ['recruiting.assignment.material.send'] };
  f.setClaims(switched);
  assert.equal((await f.bff.consumeApprovalIntent(req, prepared.body.approvalHandle)).status, 401);
  assert.equal(calls.filter(call => call.kind === 'consume').length, 1);
});

test('CP approval URLs outside the configured issuer fail closed', async t => {
  const approvalClient = { prepareApproval: async () => ({ intentId: 'd'.repeat(64),
    approvalUrl: 'https://attacker.example/review?intent=' + 'd'.repeat(64), expiresAt: now / 1000 + 300 }),
    consumeApproval: async () => { throw new Error('must not consume'); } };
  const f = await fixture(t, approvalClient);
  f.setClaims({ ...claims, scopes: ['recruiting.assignment.material.send', 'recruiting.responses.conversation.open'] });
  const { authorize, pendingCookie } = await start(f.base, 'assignment-send', 'vac_demo_001', 'neg_demo_001');
  const login = await callback(f.base, authorize.searchParams.get('state'), pendingCookie);
  const appCookie = getCookie(login, '__Host-recruiting-app-session');
  const visible = await (await fetch(`${f.base}/auth/connected/session`, { headers: { cookie: appCookie } })).json();
  const req = { method: 'POST', headers: { cookie: appCookie, origin: publicOrigin, 'x-csrf-token': visible.csrfToken } };
  const op = { profileId: claims.profileId, vacancyId: 'vac_demo_001', negotiationId: 'neg_demo_001',
    chatId: 'chat_demo_001', agreementMessageId: 'msg_agreement_001', sourceSha256: 'a'.repeat(64),
    savedPlanRevisionSha256: 'b'.repeat(64), message: 'Exact approved task',
    materialSha256: createHash('sha256').update('Exact approved task').digest('hex') };
  await assert.rejects(() => f.bff.prepareApprovalIntent(req, op), /connected_app_approval_unavailable/);
});
