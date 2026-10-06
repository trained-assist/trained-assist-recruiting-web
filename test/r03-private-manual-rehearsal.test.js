import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { legacyQueryConfigHash } from '../src/r03-private-base-plan.js';
import { runPrivateManualRehearsal } from '../src/r03-private-manual-rehearsal.js';

const profileId = 'invented_profile'; const vacancyId = 'invented_vacancy';
const ats = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
  vacancy_context: 'Вымышленный клиент', filters: { area: { id: '1' },
    min_experience_years: 0 }, required: [{ name: 'инженер', weight: 1 }], knockout: [] };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-manual-rehearsal-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['contexts', 'proactive', 'tokens', 'secrets', 'disposable'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const write = (dir, name, value) => writeFileSync(join(root, dir, name), value, { mode: 0o600 });
  const sourceDbPath = join(root, 'source.sqlite');
  const source = new Database(sourceDbPath);
  source.exec('CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES (\'unchanged\')');
  source.close(); chmodSync(sourceDbPath, 0o600);
  const stagedDbPath = join(root, 'disposable', 'candidate.sqlite');
  const staged = new Database(stagedDbPath);
  staged.exec(`CREATE TABLE cold_search_schedules (payload TEXT,enabled INTEGER,
    blocked_by_unknown_occurrence_id TEXT);
    CREATE TABLE r03_legacy_schedule_import (legacy_job_id TEXT);
    CREATE TABLE cold_search_occurrences (occurrence_id TEXT);`);
  for (let i = 0; i < 11; i++) {
    staged.prepare('INSERT INTO cold_search_schedules VALUES(?,?,?)').run(
      JSON.stringify({ migrationQuarantine: { reason: i < 8 ? 'legacy_outcome_unknown' : 'cutover_review_required' } }),
      0, `invented_block_${i}`);
    staged.prepare('INSERT INTO r03_legacy_schedule_import VALUES(?)').run(`invented_job_${i}`);
  }
  staged.close(); chmodSync(stagedDbPath, 0o600);
  const hostConfigFile = join(root, 'host-config.json');
  writeFileSync(hostConfigFile, JSON.stringify({ version: 'r03-private-host-v1', dbPath: sourceDbPath,
    profiles: [{ profileId, vacancyIds: [vacancyId], contextDirectory: join(root, 'contexts'),
      proactiveDirectory: join(root, 'proactive'), tokenDirectory: join(root, 'tokens') }] }), { mode: 0o600 });
  const stageReceiptFile = join(root, 'disposable', 'receipt.json');
  writeFileSync(stageReceiptFile, JSON.stringify({ version: 'r03-private-schedule-stage-v1',
    status: 'disposable_only', migrationId: 'invented_migration',
    sourceArchiveSha256: 'a'.repeat(64), cronSha256: 'b'.repeat(64),
    sourceDbPath, stagedDbPath, imported: 11, unknownQuarantined: 8, enabled: 0 }), { mode: 0o600 });
  write('contexts', `ats_config:${vacancyId}.json`, JSON.stringify({ value: JSON.stringify(ats) }));
  write('proactive', `queries-${vacancyId}.json`, JSON.stringify({ vacancy_id: vacancyId,
    queries: ['вымышленный инженер', 'вымышленный конструктор'],
    config_hash: legacyQueryConfigHash(ats) }));
  write('tokens', 'hh', 'invented_token');
  write('secrets', 'hh_encryption_key', 'a'.repeat(64));
  write('secrets', 'hh_user_agent', 'invented-recruiting/1.0 (contact@example.test)');
  return { root, hostConfigFile, stageReceiptFile, secretsDirectory: join(root, 'secrets'),
    sourceDbPath, stagedDbPath, profileId, vacancyId };
}

test('one query, page, request and resume write only to disposable SQLite', async t => {
  const f = fixture(t); const calls = [];
  const result = await runPrivateManualRehearsal({ ...f, execute: true,
    clock: () => new Date('2026-10-06T09:00:00.000Z'), wait: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { status: 200, ok: true, json: async () => ({ pages: 106, found: 106,
        items: [{ id: 'inventedresume', title: 'Вымышленный инженер', first_name: 'Вымышленное',
          last_name: 'Имя', area: { name: 'Вымышленная область' },
          total_experience: { months: 48 }, experience: [] }] }) };
    } });
  assert.deepEqual(result, { status: 'completed', providerRequests: 1, queryBudget: 1,
    pageBudget: 1, perPage: 1, candidateCount: 1, newCount: 1, disposableOnly: true });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get('per_page'), '1');
  const source = new Database(f.sourceDbPath, { readonly: true });
  assert.equal(source.prepare('SELECT value FROM sentinel').get().value, 'unchanged');
  assert.equal(source.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='real_hh_snapshot'").get().n, 0);
  source.close();
  const staged = new Database(f.stagedDbPath, { readonly: true });
  assert.equal(staged.prepare('SELECT COUNT(*) AS n FROM real_hh_snapshot').get().n, 1);
  assert.equal(staged.prepare('SELECT COUNT(*) AS n FROM real_hh_manual_run WHERE status=\'completed\'').get().n, 1);
  assert.equal(staged.prepare('SELECT COUNT(*) AS n FROM cold_search_schedules WHERE enabled=1').get().n, 0);
  staged.close();
  const receipt = JSON.parse(readFileSync(join(f.root, 'disposable', 'manual-rehearsal-receipt.json')));
  assert.equal(receipt.disposition, 'disposable_only');
  assert.equal(receipt.providerPages, 106);
  assert.deepEqual(receipt.limits, { queries: 1, pages: 1, perPage: 1, attempts: 1 });
});

test('provider 429 makes one attempt and leaves no accepted snapshot', async t => {
  const f = fixture(t); let requests = 0;
  const result = await runPrivateManualRehearsal({ ...f, execute: true,
    clock: () => new Date('2026-10-06T09:00:00.000Z'), wait: async () => {},
    fetchImpl: async () => { requests++; return { status: 429, ok: false,
      json: async () => { throw new Error('must not read body'); } }; } });
  assert.equal(requests, 1);
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.providerRequests, 1);
  const staged = new Database(f.stagedDbPath, { readonly: true });
  assert.equal(staged.prepare('SELECT COUNT(*) AS n FROM real_hh_snapshot').get().n, 0);
  staged.close();
});
