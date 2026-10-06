import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPrivateHostMode } from '../src/r03-private-host-cli.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { intervalPlan, nextOccurrenceAfter } from '../src/cold-search-schedules.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-host-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['context', 'proactive', 'tokens', 'secrets'].map(name => {
    const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return [name, path];
  }));
  const configFile = join(root, 'config.json');
  const dbPath = join(root, 'private.sqlite');
  writeFileSync(configFile, JSON.stringify({ version: 'r03-private-host-v1', dbPath,
    profiles: [{ profileId: 'profile_invented_001', vacancyIds: ['vacancy_invented_001'],
      contextDirectory: dirs.context, proactiveDirectory: dirs.proactive,
      tokenDirectory: dirs.tokens }] }), { mode: 0o600 });
  for (const [name, value] of Object.entries({ hh_encryption_key: 'a'.repeat(64),
    hh_client_id: 'invented_client', hh_client_secret: 'invented_secret',
    ladder_token: 'invented_ladder_token' }))
    writeFileSync(join(dirs.secrets, name), value, { mode: 0o600 });
  return { root, configFile, dbPath, secretsDirectory: dirs.secrets };
}

test('check, minute and score entrypoints open private stores without ambient provider dispatch', async t => {
  const f = fixture(t);
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected network'); };
  assert.deepEqual(await runPrivateHostMode({ mode: 'check', configFile: f.configFile }),
    { mode: 'check', status: 'ready', enabledScheduleCount: 0, blockedScheduleCount: 0 });
  assert.deepEqual(await runPrivateHostMode({ mode: 'minute', configFile: f.configFile,
    secretsDirectory: f.secretsDirectory, liveExecution: true, fetchImpl,
    clock: () => new Date('2026-10-06T00:00:00.000Z'), workerId: 'worker_invented' }),
  { mode: 'minute', status: 'completed', result: { claimed: 0, completed: 0, rejected: 0, unknown: 0 } });
  assert.deepEqual(await runPrivateHostMode({ mode: 'score', configFile: f.configFile,
    secretsDirectory: f.secretsDirectory, liveExecution: true, fetchImpl }),
  { mode: 'score', status: 'completed', processed: 0, held: 0, pending: 0, written: 0,
    stale: 0, alreadyScored: 0, failed: 0 });
  assert.equal(calls, 0);
  await assert.rejects(runPrivateHostMode({ mode: 'minute', configFile: f.configFile,
    secretsDirectory: f.secretsDirectory, fetchImpl }), /private_host_mode_unavailable/);
});

test('enabled schedule outside the private profile mapping blocks every mode', async t => {
  const f = fixture(t);
  const repo = new SqliteColdSearchScheduleRepository(f.dbPath);
  const plan = intervalPlan(24, 'vacancy_other');
  repo.upsertSchedule({ scheduleId: 'schedule_other', legacyJobId: 'legacy_other',
    profileId: 'profile_other', vacancyId: 'vacancy_other', enabled: true,
    plan, timezone: 'Europe/Moscow', jobArguments: { vacancyId: 'vacancy_other' },
    nextRunAt: nextOccurrenceAfter(plan, '2026-10-06T00:00:00.000Z'),
    leaseOwner: null, leaseUntil: null, blockedByUnknownOccurrenceId: null });
  repo.close();
  await assert.rejects(runPrivateHostMode({ mode: 'check', configFile: f.configFile }), /unbound_enabled_schedule/);
  await assert.rejects(runPrivateHostMode({ mode: 'minute', configFile: f.configFile,
    secretsDirectory: f.secretsDirectory, liveExecution: true, fetchImpl: async () => {} }),
  /unbound_enabled_schedule/);
});

test('CLI prints only a structured check result or generic failure', t => {
  const f = fixture(t);
  const executable = fileURLToPath(new URL('../src/r03-private-host-cli.js', import.meta.url));
  const checked = spawnSync(process.execPath, [executable, '--mode', 'check', '--config', f.configFile],
    { encoding: 'utf8' });
  assert.equal(checked.status, 0);
  assert.deepEqual(JSON.parse(checked.stdout), { event: 'r03.private_host', mode: 'check',
    status: 'ready', enabledScheduleCount: 0, blockedScheduleCount: 0 });
  const denied = spawnSync(process.execPath, [executable, '--mode', 'minute', '--config', f.configFile],
    { encoding: 'utf8' });
  assert.equal(denied.status, 78);
  assert.deepEqual(JSON.parse(denied.stdout), { event: 'r03.private_host',
    status: 'failed', code: 'private_host_unavailable' });
  assert.equal(denied.stderr, '');
});
