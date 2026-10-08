import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecruitingReadSessionResolver } from '../src/r01-r04-trusted-session.js';
import { createRecruitingServer } from '../src/server.js';

const now = Date.parse('2026-10-06T09:00:00Z');
const token = 'opaque-agent-session-token-with-enough-length';
const claims = { iss: 'https://agent.example.invalid', aud: 'recruiting-web', sub: 'user_1',
  profileId: 'profile_demo_001', sessionId: 'session_1', nbf: now / 1000 - 30,
  exp: now / 1000 + 300, scopes: ['recruiting.responses.read'] };
const make = (overrides = {}, ports = {}) => createRecruitingReadSessionResolver({
  verifyToken: async offered => offered === token ? { ...claims, ...overrides } : null,
  isProfileBound: async (user, profile, session) =>
    user === 'user_1' && profile === 'profile_demo_001' && session === 'session_1',
  issuer: claims.iss, audience: claims.aud, clock: () => now, ...ports });
const req = (authorization, cookie) => ({ headers: { authorization, cookie } });

test('only issuer-verified, live and bound claims resolve the selected profile', async () => {
  const resolve = make();
  assert.deepEqual(await resolve(req(`Bearer ${token}`)), { profileId: claims.profileId,
    scopes: ['recruiting.responses.read'] });
  assert.equal(await resolve(req(undefined, '__Host-r03-proactive=any')), null);
  assert.equal(await resolve(req('Bearer wrong', '__Host-r03-proactive=any')), null);
  assert.equal(await make({ iss: 'other' })(req(`Bearer ${token}`)), null);
  assert.equal(await make({ aud: 'other' })(req(`Bearer ${token}`)), null);
  assert.equal(await make({ profileId: 'profile_demo_002' })(req(`Bearer ${token}`)), null);
  assert.equal(await make({ sessionId: 'session_2' })(req(`Bearer ${token}`)), null);
  assert.equal(await make({ nbf: now / 1000 + 1 })(req(`Bearer ${token}`)), null);
  assert.equal(await make({ exp: now / 1000 })(req(`Bearer ${token}`)), null);
  assert.equal(await make({ exp: now / 1000 + 3601 })(req(`Bearer ${token}`)), null);
  assert.equal(await make({}, { isProfileBound: async () => false })(req(`Bearer ${token}`)), null);
  assert.equal(await make({}, { verifyToken: async () => { throw Error('issuer down'); } })(req(`Bearer ${token}`)), null);
});

test('R-03 scope and cookie cannot open R-01 or R-04 routes', async t => {
  let responseCalls = 0;
  let reportCalls = 0;
  let current = { ...claims, scopes: ['recruiting.candidateSearch'] };
  const resolve = createRecruitingReadSessionResolver({ verifyToken: async () => current,
    isProfileBound: async () => true, issuer: claims.iss, audience: claims.aud, clock: () => now });
  const server = createRecruitingServer({ resolveTrustedProfileContext: resolve,
    liveResponseRead: async () => { responseCalls++; return { status: 200, body: {} }; },
    acceptedReportSourceRead: async () => { reportCalls++; return { status: 200, body: {} }; } });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => server.close(ok)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/ui`;
  const urls = [`${base}/hh-responses?vacancyId=vac_demo_001`,
    `${base}/accepted-report-source?vacancyId=vac_demo_001&candidateId=candidate_demo_001`];
  for (const url of urls) {
    assert.equal((await fetch(url, { headers: { cookie: '__Host-r03-proactive=old' } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 403);
  }
  assert.equal(responseCalls, 0);
  assert.equal(reportCalls, 0);
  current = { ...claims, scopes: ['recruiting.responses.read'] };
  assert.equal((await fetch(urls[0], { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(urls[1], { headers: { authorization: `Bearer ${token}` } })).status, 403);
  current = { ...claims, scopes: ['recruiting.reports.read'] };
  assert.equal((await fetch(urls[0], { headers: { authorization: `Bearer ${token}` } })).status, 403);
  assert.equal((await fetch(urls[1], { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal(responseCalls, 1);
  assert.equal(reportCalls, 1);
});
