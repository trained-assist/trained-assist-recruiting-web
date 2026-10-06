import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { legacyQueryConfigHash } from '../src/r03-private-base-plan.js';
import { runPrivateScheduledRehearsal } from '../src/r03-private-scheduled-rehearsal.js';

const profileId = 'invented_profile'; const vacancyId = 'invented_vacancy';
const ats = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
  vacancy_context: 'Вымышленный клиент', filters: { area: { id: '1' },
    min_experience_years: 0 }, required: [{ name: 'инженер', weight: 1 }], knockout: [] };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-scheduled-rehearsal-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['contexts', 'proactive', 'tokens', 'secrets', 'stage'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const write = (dir, name, value) => writeFileSync(join(root, dir, name), value, { mode: 0o600 });
  const sourceDbPath = join(root, 'source.sqlite');
  const source = new Database(sourceDbPath);
  source.exec('CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES (\'unchanged\')');
  source.close(); chmodSync(sourceDbPath, 0o600);
  const stageDbPath = join(root, 'stage', 'candidate.sqlite');
  const schedules = new SqliteColdSearchScheduleRepository(stageDbPath);
  schedules.db.exec('CREATE TABLE r03_legacy_schedule_import (legacy_job_id TEXT)');
  for (let i = 0; i < 11; i++) {
    schedules.persistSchedule({ scheduleId: `invented_schedule_${i}`, legacyJobId: `invented_job_${i}`,
      profileId, vacancyId, enabled: false, nextRunAt: '2099-01-01T00:00:00.000Z', leaseOwner: null,
      leaseUntil: null, blockedByUnknownOccurrenceId: `invented_block_${i}`,
      migrationQuarantine: { reason: i < 8 ? 'legacy_outcome_unknown' : 'cutover_review_required' } });
    schedules.db.prepare('INSERT INTO r03_legacy_schedule_import VALUES(?)').run(`invented_job_${i}`);
  }
  schedules.close();
  const hostConfigFile = join(root, 'host-config.json');
  writeFileSync(hostConfigFile, JSON.stringify({ version: 'r03-private-host-v1', dbPath: sourceDbPath,
    profiles: [{ profileId, vacancyIds: [vacancyId], contextDirectory: join(root, 'contexts'),
      proactiveDirectory: join(root, 'proactive'), tokenDirectory: join(root, 'tokens') }] }), { mode: 0o600 });
  const stageReceiptFile = join(root, 'stage', 'receipt.json');
  writeFileSync(stageReceiptFile, JSON.stringify({ version: 'r03-private-schedule-stage-v1',
    status: 'disposable_only', migrationId: 'invented_migration', sourceDbPath,
    stagedDbPath: stageDbPath, imported: 11, unknownQuarantined: 8, enabled: 0 }), { mode: 0o600 });
  write('contexts', `ats_config:${vacancyId}.json`, JSON.stringify({ value: JSON.stringify(ats) }));
  write('proactive', `queries-${vacancyId}.json`, JSON.stringify({ vacancy_id: vacancyId,
    queries: ['вымышленный инженер', 'вымышленный конструктор'],
    config_hash: legacyQueryConfigHash(ats) }));
  write('tokens', 'hh', 'invented_token');
  write('secrets', 'hh_encryption_key', 'a'.repeat(64));
  write('secrets', 'hh_user_agent', 'invented-recruiting/1.0 (contact@example.test)');
  write('secrets', 'ladder_token', 'invented_ladder_token');
  return { root, hostConfigFile, stageReceiptFile, secretsDirectory: join(root, 'secrets'),
    outputDirectory: join(root, 'scheduled'), sourceDbPath, stageDbPath, profileId, vacancyId,
    execute: true, clock: () => new Date('2026-10-06T09:00:00.000Z') };
}

test('one scheduled slot runs bounded HH and assessment only in disposable copy', async t => {
  const f = fixture(t); const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (new URL(url).origin === 'https://api.hh.ru')
      return { status: 200, ok: true, json: async () => ({ pages: 106, found: 106,
        items: [{ id: 'inventedresume', title: 'Вымышленный инженер', first_name: 'Вымышленное',
          last_name: 'Имя', area: { name: 'Вымышленная область' },
          total_experience: { months: 48 }, experience: [] }] }) };
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: {
      content: '{"score":8,"knockout_failed":[]}' } }] }) };
  };
  const result = await runPrivateScheduledRehearsal({ ...f, fetchImpl });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.providerRequests, 1);
  assert.equal(result.assessmentRequests, 1);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.newCount, 1);
  assert.equal(result.assessmentWritten, 1);
  assert.equal(result.assessmentFailed, 0);
  assert.equal(result.acceptedForMorning, false);
  assert.equal(result.disposition, 'partial_rehearsal');
  assert.equal(result.freshness, 'not_accepted_partial');
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).searchParams.get('per_page'), '1');
  const source = new Database(f.sourceDbPath, { readonly: true });
  assert.equal(source.prepare('SELECT value FROM sentinel').get().value, 'unchanged');
  source.close();
  const stage = new Database(f.stageDbPath, { readonly: true });
  assert.equal(stage.prepare('SELECT COUNT(*) AS n FROM cold_search_occurrences').get().n, 0);
  assert.equal(stage.prepare('SELECT COUNT(*) AS n FROM cold_search_schedules WHERE enabled=1').get().n, 0);
  stage.close();
  const disposable = new Database(join(f.outputDirectory, 'candidate.sqlite'), { readonly: true });
  assert.equal(disposable.prepare('SELECT COUNT(*) AS n FROM cold_search_occurrences WHERE status=\'succeeded\'').get().n, 1);
  assert.equal(disposable.prepare('SELECT COUNT(*) AS n FROM cold_search_schedules WHERE enabled=0').get().n, 12);
  assert.equal(disposable.prepare('SELECT COUNT(*) AS n FROM real_hh_snapshot WHERE source=\'scheduled\'').get().n, 1);
  disposable.close();
  const receipt = JSON.parse(readFileSync(join(f.outputDirectory, 'receipt.json')));
  assert.equal(receipt.providerPages, 106);
  assert.equal(receipt.disposition, 'partial_rehearsal');
  assert.equal(receipt.acceptedForMorning, false);
  assert.deepEqual(receipt.limits, { queries: 1, pages: 1, perPage: 1, hhAttempts: 1, assessments: 1 });
  const replay = await runPrivateScheduledRehearsal({ ...f,
    fetchImpl: async () => { throw new Error('must not redispatch'); } });
  assert.deepEqual(replay, { status: 'replayed', originalStatus: 'succeeded',
    providerRequests: 0, assessmentRequests: 0, assessmentFailed: 0,
    acceptedForMorning: false, disposition: 'partial_rehearsal', disposableOnly: true });
  unlinkSync(join(f.outputDirectory, 'receipt.json'));
  await assert.rejects(runPrivateScheduledRehearsal({ ...f,
    fetchImpl: async () => { throw new Error('must not redispatch'); } }),
  /private_scheduled_rehearsal_unavailable/);
});

test('HH 429 quarantines one occurrence without replay or morning freshness', async t => {
  const f = fixture(t); let requests = 0;
  const result = await runPrivateScheduledRehearsal({ ...f,
    fetchImpl: async () => { requests++; return { status: 429, ok: false }; } });
  assert.equal(requests, 1);
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.providerRequests, 1);
  assert.equal(result.assessmentRequests, 0);
  assert.equal(result.freshness, 'not_accepted_partial');
  const disposable = new Database(join(f.outputDirectory, 'candidate.sqlite'), { readonly: true });
  assert.equal(disposable.prepare('SELECT COUNT(*) AS n FROM real_hh_snapshot').get().n, 0);
  assert.equal(disposable.prepare('SELECT COUNT(*) AS n FROM cold_search_occurrences WHERE status=\'outcome_unknown\'').get().n, 1);
  disposable.close();
  const replay = await runPrivateScheduledRehearsal({ ...f,
    fetchImpl: async () => { throw new Error('must not redispatch'); } });
  assert.equal(replay.providerRequests, 0);
});
