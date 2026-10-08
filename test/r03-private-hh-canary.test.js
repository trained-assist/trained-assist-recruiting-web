import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrivateHhCanary } from '../src/r03-private-hh-canary.js';
import { legacyQueryConfigHash } from '../src/r03-private-base-plan.js';

const profileId = 'invented_profile';
const vacancyId = 'invented_vacancy';
const encryptionKey = 'a'.repeat(64);
const sealed = value => {
  const iv = Buffer.alloc(16, 3); const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([2]), iv, cipher.getAuthTag(), ciphertext]).toString('base64');
};
const ats = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный аналитик',
  vacancy_context: 'Вымышленная организация', filters: { area: { id: '1' } },
  required: [{ name: 'аналитик', weight: 1 }], knockout: [] };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-hh-canary-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['contexts', 'proactive', 'tokens', 'secrets'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const configFile = join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify({ version: 'r03-private-host-v1',
    dbPath: join(root, 'candidate.sqlite'), profiles: [{ profileId, vacancyIds: [vacancyId],
      contextDirectory: join(root, 'contexts'), proactiveDirectory: join(root, 'proactive'),
      tokenDirectory: join(root, 'tokens') }] }), { mode: 0o600 });
  const write = (dir, name, value) => writeFileSync(join(root, dir, name), value, { mode: 0o600 });
  write('contexts', `ats_config:${vacancyId}.json`, JSON.stringify({ value: JSON.stringify(ats) }));
  write('proactive', `queries-${vacancyId}.json`, JSON.stringify({ vacancy_id: vacancyId,
    queries: ['вымышленный аналитик'], config_hash: legacyQueryConfigHash(ats) }));
  write('tokens', 'hh', sealed({ access_token: 'invented_token' }));
  write('secrets', 'hh_encryption_key', encryptionKey);
  write('secrets', 'hh_user_agent', 'invented-recruiting/1.0 (contact@example.test)');
  return { configFile, secretsDirectory: join(root, 'secrets'), profileId, vacancyId, write };
}

test('one owned read-only HH canary sends contact headers and emits aggregate only', async t => {
  const f = fixture(t); const calls = [];
  const result = await runPrivateHhCanary({ ...f, execute: true, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({ items: [{ id: 'PRIVATE_SHOULD_NOT_LEAK' }],
      found: 42, pages: 42 }) };
  } });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get('per_page'), '1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['HH-User-Agent'], 'invented-recruiting/1.0 (contact@example.test)');
  assert.equal(calls[0].init.headers['User-Agent'], calls[0].init.headers['HH-User-Agent']);
  assert.deepEqual(result, { status: 'ok', httpStatus: 200, returnedCount: 1,
    foundCount: 42, pageCount: 42 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SHOULD_NOT_LEAK|invented_token/);
});

test('unowned, missing contact, stale query and missing execute fail before fetch', async t => {
  const f = fixture(t); let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('unexpected'); };
  await assert.rejects(runPrivateHhCanary({ ...f, fetchImpl }), /private_hh_canary_unavailable/);
  await assert.rejects(runPrivateHhCanary({ ...f, vacancyId: 'other', execute: true, fetchImpl }),
    /private_hh_canary_unavailable/);
  f.write('secrets', 'hh_user_agent', 'invented-recruiting/1.0');
  await assert.rejects(runPrivateHhCanary({ ...f, execute: true, fetchImpl }),
    /HH contact user agent required/);
  f.write('secrets', 'hh_user_agent', 'invented-recruiting/1.0 (contact@example.test)');
  f.write('proactive', `queries-${vacancyId}.json`, JSON.stringify({ vacancy_id: vacancyId,
    queries: ['old query'], config_hash: 'stale' }));
  await assert.rejects(runPrivateHhCanary({ ...f, execute: true, fetchImpl }),
    /private_search_plan_unavailable/);
  assert.equal(requests, 0);
});

test('provider rejection is status-only and never retries or refreshes a token', async t => {
  const f = fixture(t); let requests = 0;
  const result = await runPrivateHhCanary({ ...f, execute: true, fetchImpl: async () => {
    requests++; return { status: 401, json: async () => { throw new Error('must not read body'); } };
  } });
  assert.deepEqual(result, { status: 'provider_rejected', httpStatus: 401 });
  assert.equal(requests, 1);
});
