import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteConnectedAppBffStore } from '../src/sqlite-connected-app-bff-store.js';

test('encrypted pending and session records survive restart, expire and cannot replay', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'connected-bff-store-')));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'bff.sqlite');
  const encryptionKey = 'a'.repeat(64);
  let now = 1000;
  const open = () => new SqliteConnectedAppBffStore({ filename, encryptionKey, clock: () => now });
  const pendingKey = '1'.repeat(64);
  const sessionKey = '2'.repeat(64);
  const approvalKey = '3'.repeat(64);
  let first = open();
  await first.putPending(pendingKey, { state: 'state-secret', verifier: 'verifier-secret', createdAt: now });
  await first.putSession(sessionKey, { token: 'token-secret', csrf: 'csrf-secret', expiresAt: now + 200_000 });
  await first.putApproval(approvalKey, { intentId: 'intent-secret', receipt: { receiptId: 'receipt-secret' }, expiresAt: 30 });
  first.close();
  const raw = readdirSync(directory).map(name => readFileSync(join(directory, name)).toString('latin1')).join('');
  for (const secret of ['state-secret', 'verifier-secret', 'token-secret', 'csrf-secret', 'intent-secret', 'receipt-secret'])
    assert.equal(raw.includes(secret), false);
  const second = open();
  assert.deepEqual(await second.takePending(pendingKey), {
    state: 'state-secret', verifier: 'verifier-secret', createdAt: 1000 });
  assert.equal(await second.takePending(pendingKey), null);
  assert.equal((await second.getSession(sessionKey)).token, 'token-secret');
  assert.deepEqual(await second.getApproval(approvalKey), { intentId: 'intent-secret', receipt: { receiptId: 'receipt-secret' }, expiresAt: 30 });
  second.close();
  const third = open();
  assert.equal((await third.getSession(sessionKey)).csrf, 'csrf-secret');
  now += 200_001;
  assert.equal(await third.getApproval(approvalKey), null);
  assert.equal(await third.getSession(sessionKey), null);
  assert.equal(third.prune(), 0);
  third.close();
});

test('two connections atomically consume one pending transaction and reject unsafe store paths', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'connected-bff-store-')));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { filename: join(directory, 'bff.sqlite'), encryptionKey: 'b'.repeat(64), clock: () => 10_000 };
  const left = new SqliteConnectedAppBffStore(options);
  const right = new SqliteConnectedAppBffStore(options);
  const handle = 'f'.repeat(64);
  await left.putPending(handle, { createdAt: 10_000, state: 'one', verifier: 'two' });
  const results = await Promise.all([left.takePending(handle), right.takePending(handle)]);
  assert.equal(results.filter(Boolean).length, 1);
  left.close(); right.close();
  chmodSync(directory, 0o755);
  assert.throws(() => new SqliteConnectedAppBffStore(options), /private_bff_store_configuration_required/);
});
