import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPrivateHostMode } from '../src/r03-private-host-cli.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { intervalPlan, nextOccurrenceAfter } from '../src/cold-search-schedules.js';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { SqliteRealHhCandidateState, REAL_HH_RESULT_VERSION } from '../src/sqlite-real-hh-candidate-state.js';
import { createPrivateBaseSearchPlan } from '../src/r03-private-base-plan.js';

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
    hh_user_agent: 'invented-recruiting/1.0 (contact@example.test)',
    ladder_token: 'invented_ladder_token' }))
    writeFileSync(join(dirs.secrets, name), value, { mode: 0o600 });
  return { root, dirs, configFile, dbPath, secretsDirectory: dirs.secrets };
}

test('score CLI consumes accepted snapshot with real ATS handler and fake ladder transport', async t => {
  const f = fixture(t);
  const profileId = 'profile_invented_001';
  const vacancyId = 'vacancy_invented_001';
  const ats = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
    vacancy_context: 'Вымышленная фабрика', filters: { area: 1, min_experience_years: 0 },
    required: [{ name: 'инженер', weight: 2 }], knockout: [] };
  writeFileSync(join(f.dirs.context, `ats_config:${vacancyId}.json`),
    JSON.stringify({ value: JSON.stringify(ats) }), { mode: 0o600 });
  writeFileSync(join(f.dirs.proactive, `queries-${vacancyId}.json`),
    JSON.stringify({ vacancy_id: vacancyId, queries: ['инженер'], manual: true,
      config_hash: 'manual' }), { mode: 0o600 });
  const plan = await createPrivateBaseSearchPlan({ resolveProfileBinding: async () => ({ profileId,
    contextDirectory: f.dirs.context, proactiveDirectory: f.dirs.proactive }),
    isVacancyOwned: () => true })(profileId, vacancyId);
  const schedules = new SqliteColdSearchScheduleRepository(f.dbPath);
  const state = new SqliteRealHhCandidateState({ filename: f.dbPath,
    isVacancyOwned: (p, v) => p === profileId && v === vacancyId });
  t.after(() => { if (state.db.open) state.close(); if (schedules.db.open) schedules.close(); });
  const candidate = mapHhResumeCandidate({ id: 'inventedresume', title: 'Вымышленный инженер',
    first_name: 'Вымышленное', last_name: 'Имя', area: { name: 'Вымышленный регион' },
    total_experience: { months: 48 }, experience: [] }, ats, vacancyId).candidate;
  const snapshot = state.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION, profileId,
    vacancyId, jobId: 'accepted_job', source: 'scheduled',
    searchedAt: '2026-10-07T06:00:00.000Z', criteriaRevision: plan.criteriaRevision,
    sourceRevision: 'source_invented', totalCollected: 1, candidates: [candidate] });
  const schedule = { scheduleId: 'schedule_invented', legacyJobId: 'legacy_invented',
    profileId, vacancyId, enabled: false, nextRunAt: '2099-01-01T00:00:00.000Z',
    leaseOwner: null, leaseUntil: null, blockedByUnknownOccurrenceId: null };
  schedules.persistSchedule(schedule);
  const occurrence = { occurrenceId: 'occurrence_invented', scheduleId: schedule.scheduleId,
    legacyJobId: schedule.legacyJobId, profileId, vacancyId,
    scheduledAt: snapshot.searchedAt, status: 'succeeded', jobId: snapshot.jobId,
    snapshot: { sourceRevision: snapshot.sourceRevision,
      resultRevision: snapshot.resultRevision, resultCount: snapshot.candidateCount } };
  schedules.writeOccurrence.run({ ...occurrence, leaseOwner: null, leaseUntil: null,
    payload: JSON.stringify(occurrence) });
  let calls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://llm-ladder.trainedassist.store/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer invented_ladder_token');
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: {
      content: '{"score":8,"knockout_failed":[]}' } }] }) };
  };
  for (const name of ['hh_encryption_key', 'hh_client_id', 'hh_client_secret', 'hh_user_agent'])
    unlinkSync(join(f.secretsDirectory, name));
  const args = { mode: 'score', configFile: f.configFile, secretsDirectory: f.secretsDirectory,
    liveExecution: true, fetchImpl, clock: () => new Date('2026-10-07T09:00:00.000Z'),
    workerId: 'worker_invented' };
  assert.equal((await runPrivateHostMode(args)).written, 1);
  assert.equal(calls, 1);
  assert.equal(state.assessedResultPage({ profileId, vacancyId, jobId: snapshot.jobId,
    limit: 1 }).items[0].atsScore, 8);
  assert.equal((await runPrivateHostMode(args)).written, 0);
  assert.equal(calls, 1);
});

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
  for (const name of ['hh_encryption_key', 'hh_client_id', 'hh_client_secret', 'hh_user_agent'])
    unlinkSync(join(f.secretsDirectory, name));
  assert.deepEqual(await runPrivateHostMode({ mode: 'score', configFile: f.configFile,
    secretsDirectory: f.secretsDirectory, liveExecution: true, fetchImpl }),
  { mode: 'score', status: 'completed', scopes: 1, claimed: 0, written: 0,
    deferred: 0, blocked: 0, unknown: 0, inserted: 0, acceptedJobs: 0, budgetRemaining: 6 });
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
