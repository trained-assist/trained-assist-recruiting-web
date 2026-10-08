import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { legacyQueryConfigHash } from '../src/r03-private-base-plan.js';
import { runPrivateFullCostPreflight } from '../src/r03-private-full-cost-preflight.js';

const profileId = 'invented_profile'; const vacancyId = 'invented_vacancy';
const ats = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
  vacancy_context: 'Вымышленный клиент', filters: { area: { id: '1' },
    min_experience_years: 0 }, required: [{ name: 'инженер', weight: 1 }], knockout: [] };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-full-cost-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['contexts', 'proactive', 'tokens', 'secrets', 'stage'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const write = (dir, name, value) => writeFileSync(join(root, dir, name), value, { mode: 0o600 });
  const sourceDbPath = join(root, 'source.sqlite');
  const source = new Database(sourceDbPath);
  source.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES(\'unchanged\')');
  source.close(); chmodSync(sourceDbPath, 0o600);
  const hostConfigFile = join(root, 'host-config.json');
  writeFileSync(hostConfigFile, JSON.stringify({ version: 'r03-private-host-v1', dbPath: sourceDbPath,
    profiles: [{ profileId, vacancyIds: [vacancyId], contextDirectory: join(root, 'contexts'),
      proactiveDirectory: join(root, 'proactive'), tokenDirectory: join(root, 'tokens') }] }), { mode: 0o600 });
  const stageReceiptFile = join(root, 'stage', 'receipt.json');
  writeFileSync(stageReceiptFile, JSON.stringify({ version: 'r03-private-schedule-stage-v1',
    status: 'disposable_only', migrationId: 'invented_migration', sourceDbPath,
    sourceArchiveSha256: 'a'.repeat(64), cronSha256: 'b'.repeat(64),
    imported: 11, unknownQuarantined: 8, enabled: 0 }), { mode: 0o600 });
  write('contexts', `ats_config:${vacancyId}.json`, JSON.stringify({ value: JSON.stringify(ats) }));
  write('proactive', `queries-${vacancyId}.json`, JSON.stringify({ vacancy_id: vacancyId,
    queries: ['вымышленный инженер', 'вымышленный конструктор'],
    config_hash: legacyQueryConfigHash(ats) }));
  write('tokens', 'hh', 'invented_token');
  write('secrets', 'hh_encryption_key', 'a'.repeat(64));
  write('secrets', 'hh_user_agent', 'invented-recruiting/1.0 (contact@example.test)');
  return { root, hostConfigFile, stageReceiptFile, secretsDirectory: join(root, 'secrets'),
    outputFile: join(root, 'cost-preflight.json'), profileId, vacancyId,
    execute: true, clock: () => new Date('2026-10-06T09:00:00.000Z') };
}

test('read-only page-zero probes write owner-only SHA-bound aggregate estimate', async t => {
  const f = fixture(t); let requests = 0;
  const result = await runPrivateFullCostPreflight({ ...f, fetchImpl: async (url, init) => {
    requests++;
    assert.equal(init.method, 'GET');
    assert.equal(new URL(url).searchParams.get('page'), '0');
    assert.equal(new URL(url).searchParams.get('per_page'), '1');
    return { status: 200, ok: true, json: async () => ({ pages: 106, found: 106,
      items: [{ id: 'inventedresume' }] }) };
  } });
  assert.equal(requests, 2);
  assert.equal(result.status, 'ready');
  assert.equal(result.estimatedRequests, 6);
  assert.equal(result.rawItemUpperBound, 212);
  const receipt = JSON.parse(readFileSync(f.outputFile));
  assert.equal(receipt.disposition, 'read_only_estimate');
  assert.equal(receipt.queryHashes.length, 2);
  assert.equal((statSync(f.outputFile).mode & 0o777), 0o600);
  assert.equal(readFileSync(f.outputFile, 'utf8').includes('invented_token'), false);
  const source = new Database(join(f.root, 'source.sqlite'), { readonly: true });
  assert.equal(source.prepare('SELECT value FROM sentinel').get().value, 'unchanged');
  source.close();
  await assert.rejects(runPrivateFullCostPreflight({ ...f,
    fetchImpl: async () => { throw new Error('must not redispatch'); } }),
  /private_full_cost_preflight_unavailable/);
});

test('provider rejection leaves no preflight receipt', async t => {
  const f = fixture(t);
  await assert.rejects(runPrivateFullCostPreflight({ ...f, fetchImpl: async () =>
    ({ status: 429, ok: false, json: async () => ({}) }) }));
  assert.equal(existsSync(f.outputFile), false);
});
