import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateHhCredentialBroker } from '../src/r03-private-hh-credential.js';
import { createHhResumeTransport } from '../src/hh-resume-transport.js';

const profileId = 'profile_synthetic_001';
const key = '4'.repeat(64);
function encrypted(value) {
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([2]), iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
function fixture(t, token = { access_token: 'old_synthetic_access', refresh_token: 'old_synthetic_refresh' }) {
  const root = mkdtempSync(join(tmpdir(), 'r03-credential-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenDirectory = join(root, 'tokens');
  mkdirSync(tokenDirectory, { mode: 0o700 });
  writeFileSync(join(tokenDirectory, 'hh'), JSON.stringify(token), { mode: 0o600 });
  const resolveProfileBinding = async profile => profile === profileId
    ? { profileId, tokenDirectory } : null;
  return { root, tokenDirectory, resolveProfileBinding };
}

test('private broker reads legacy plaintext and v2 credential for one bound profile', async t => {
  const f = fixture(t);
  const broker = createPrivateHhCredentialBroker({ resolveProfileBinding: f.resolveProfileBinding,
    encryptionKey: key, clientId: 'synthetic_client', clientSecret: 'synthetic_secret',
    fetchImpl: async () => { throw new Error('no network expected'); } });
  assert.deepEqual(await broker.loadCredential(profileId), { profileId, accessToken: 'old_synthetic_access' });
  writeFileSync(join(f.tokenDirectory, 'hh'), encrypted({ access_token: 'sealed_synthetic_access',
    refresh_token: 'sealed_synthetic_refresh' }));
  assert.deepEqual(await broker.loadCredential(profileId), { profileId, accessToken: 'sealed_synthetic_access' });
  await assert.rejects(broker.loadCredential('profile_synthetic_002'), /hh_credential_scope_denied/);
  const wrong = createPrivateHhCredentialBroker({ resolveProfileBinding: f.resolveProfileBinding,
    encryptionKey: '5'.repeat(64), fetchImpl: async () => null });
  await assert.rejects(wrong.loadCredential(profileId), /hh_credential_decryption_failed/);
});

test('401 refresh uses one OAuth request, rotates encrypted token and retries HH read once', async t => {
  const f = fixture(t);
  let oauthCalls = 0, hhCalls = 0;
  const fetchImpl = async (url, options) => {
    if (url === 'https://hh.ru/oauth/token') {
      oauthCalls++;
      assert.equal(options.method, 'POST');
      assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'old_synthetic_refresh');
      return { ok: true, json: async () => ({ access_token: 'new_synthetic_access',
        refresh_token: 'new_synthetic_refresh' }) };
    }
    hhCalls++;
    return options.headers.Authorization === 'Bearer old_synthetic_access'
      ? { status: 401, ok: false, json: async () => ({}) }
      : { status: 200, ok: true, json: async () => ({ items: [], found: 0, pages: 0 }) };
  };
  const broker = createPrivateHhCredentialBroker({ resolveProfileBinding: f.resolveProfileBinding,
    encryptionKey: key, clientId: 'synthetic_client', clientSecret: 'synthetic_secret', fetchImpl });
  const transport = createHhResumeTransport({ loadVacancyContext: async (profile, vacancy) => ({
    profileId: profile, vacancyId: vacancy, config: { area: null }, vacancy: {} }),
  loadCredential: broker.loadCredential, refreshCredential: broker.refreshCredential, fetchImpl });
  const result = await transport.search({ trustedContext: { profileId, scopes: ['recruiting.candidateSearch'] },
    vacancyId: 'vacancy_synthetic_001', query: 'вымышленный инженер' });
  assert.deepEqual(result.items, []);
  assert.equal(oauthCalls, 1);
  assert.equal(hhCalls, 2);
  assert.deepEqual(await broker.loadCredential(profileId), { profileId, accessToken: 'new_synthetic_access' });
  assert.notEqual(readFileSync(join(f.tokenDirectory, 'hh'), 'utf8').trimStart()[0], '{',
    'refresh writes the legacy v2 encrypted envelope');
  assert.deepEqual(await broker.refreshCredential(profileId, 'old_synthetic_access'),
    { profileId, accessToken: 'new_synthetic_access' });
  assert.equal(oauthCalls, 1, 'a stale caller observes the rotated token without another POST');
});

test('symlinked file and unresolved refresh lock fail closed before OAuth dispatch', async t => {
  const f = fixture(t);
  let oauthCalls = 0;
  const broker = createPrivateHhCredentialBroker({ resolveProfileBinding: f.resolveProfileBinding,
    encryptionKey: key, clientId: 'synthetic_client', clientSecret: 'synthetic_secret',
    fetchImpl: async () => { oauthCalls++; throw new Error('must not be called'); }, sleep: async () => {} });
  mkdirSync(join(f.tokenDirectory, 'hh.refresh.lock'), { mode: 0o700 });
  await assert.rejects(broker.refreshCredential(profileId, 'old_synthetic_access'), /hh_refresh_locked/);
  assert.equal(oauthCalls, 0);
  rmSync(join(f.tokenDirectory, 'hh.refresh.lock'), { recursive: true });
  rmSync(join(f.tokenDirectory, 'hh'));
  symlinkSync(join(f.root, 'outside'), join(f.tokenDirectory, 'hh'));
  await assert.rejects(broker.loadCredential(profileId), /hh_credential_unavailable/);
});

test('OAuth refusal retains original credential and releases the refresh lock', async t => {
  const f = fixture(t);
  const before = readFileSync(join(f.tokenDirectory, 'hh'), 'utf8');
  const broker = createPrivateHhCredentialBroker({ resolveProfileBinding: f.resolveProfileBinding,
    encryptionKey: key, clientId: 'synthetic_client', clientSecret: 'synthetic_secret',
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'invalid_grant' }) }) });
  await assert.rejects(broker.refreshCredential(profileId, 'old_synthetic_access'), /hh_refresh_unavailable/);
  assert.equal(readFileSync(join(f.tokenDirectory, 'hh'), 'utf8'), before);
  assert.equal(existsSync(join(f.tokenDirectory, 'hh.refresh.lock')), false);
});
