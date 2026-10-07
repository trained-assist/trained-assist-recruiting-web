import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createColdSearchScheduleHandler } from '../src/cold-search-schedules.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { SqliteCandidateSearchJobs } from '../src/sqlite-candidate-search-jobs.js';
import { SqliteCandidateStateStore } from '../src/sqlite-candidate-state.js';
import { SqliteMinuteWorkerLease } from '../src/sqlite-minute-worker-lease.js';
import { createRecruitingServer } from '../src/server.js';

const script = new URL('../src/r03-minute-worker.js', import.meta.url).pathname;
const principal = { profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] };
const request = vacancyId => ({ vacancyId, criteriaRevision: 'criteria-search-demo-r1', criteria: { keywords: ['synthetic engineer'], regions: ['region_demo_001'] } });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'r03-minute-worker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'state.sqlite');
}
function cli(dbPath, action, at, extra = []) {
  const output = spawnSync(process.execPath, [script, '--db', dbPath, action, '--synthetic-fixture', '--synthetic-dry-run', ...(at ? ['--at', at] : []), ...extra], { encoding: 'utf8', timeout: 10_000 });
  return { status: output.status, rows: output.stdout.trim().split('\n').filter(Boolean).map(JSON.parse), stderr: output.stderr };
}
async function seed(dbPath, vacancyId = 'vac_demo_001') {
  const repository = new SqliteColdSearchScheduleRepository(dbPath);
  try {
    const schedule = createColdSearchScheduleHandler({ repository,
      clock: () => new Date('2026-10-06T00:00:00.000Z'),
      resolveSearchRequest: async (_profileId, id) => request(id),
      executeSearch: async () => { throw new Error('seed must never execute a search'); }
    });
    const enabled = await schedule.handle({ action: 'enable', vacancyId, interval_hours: 1 }, principal);
    return enabled.schedule;
  } finally { repository.close(); }
}

test('CLI check, due tick, second tick and reopen show one persisted complete search', async t => {
  const dbPath = fixture(t);
  const enabled = await seed(dbPath);
  const checked = cli(dbPath, '--check', enabled.nextRunAt);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.rows[0].event, 'r03.worker.ready');
  assert.equal(checked.rows[0].enabledScheduleCount, 1);
  const first = cli(dbPath, '--once', enabled.nextRunAt);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual([first.rows[0].claimed, first.rows[0].completed, first.rows[0].unknown], [1, 1, 0]);
  const second = cli(dbPath, '--once', enabled.nextRunAt);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual([second.rows[0].claimed, second.rows[0].completed], [0, 0]);
  const repository = new SqliteColdSearchScheduleRepository(dbPath);
  const jobs = new SqliteCandidateSearchJobs({ filename: dbPath });
  try {
    const occurrences = repository.listOccurrences(principal.profileId);
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0].status, 'succeeded');
    assert.equal(jobs.get(principal.profileId, occurrences[0].jobId).status, 'completed');
    assert.equal(jobs.results(principal.profileId, occurrences[0].jobId, { limit: 50, cursor: null }).items.length, 3);
  } finally { jobs.close(); repository.close(); }
});

test('CLI schedule tick persists accumulated candidates for web API after process restart', async t => {
  const dbPath = fixture(t);
  const enabled = await seed(dbPath);
  const tick = cli(dbPath, '--once', enabled.nextRunAt);
  assert.equal(tick.status, 0, tick.stderr);
  assert.equal(tick.rows[0].completed, 1);
  const schedules = new SqliteColdSearchScheduleRepository(dbPath);
  const jobs = new SqliteCandidateSearchJobs({ filename: dbPath });
  const candidates = new SqliteCandidateStateStore({ filename: dbPath });
  const server = createRecruitingServer({
    candidateSearchScheduleRepository: schedules,
    candidateSearchJobStore: jobs,
    candidateStateStore: candidates,
    resolveTrustedProfileContext: () => principal
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/hh/proactive/candidates?vacancy_id=vac_demo_001`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'completed');
    assert.equal(body.source, 'scheduled');
    assert.equal(body.total, 3);
    assert.equal(body.latestRunTotal, 3);
    assert.equal(body.newCount, 3);
    assert.deepEqual(body.candidates.map(row => row.candidateRef), ['candidate_search_demo_001', 'candidate_search_demo_002', 'candidate_search_demo_003']);
    assert.equal(body.candidates.every(row => row.inLatestRun && row.isNew), true);
    assert.equal(candidates.read(principal.profileId).snapshotsByVacancy.vac_demo_001.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    candidates.close(); jobs.close(); schedules.close();
  }
});

test('CLI refuses missing mode and an enabled schedule outside synthetic binding before any claim', async t => {
  const dbPath = fixture(t);
  const missingMode = spawnSync(process.execPath, [script, '--db', dbPath, '--once'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(missingMode.status, 78);
  assert.equal(JSON.parse(missingMode.stdout).event, 'r03.worker.error');
  const enabled = await seed(dbPath, 'vac_demo_002');
  const rejected = cli(dbPath, '--once', enabled.nextRunAt);
  assert.equal(rejected.status, 78);
  assert.equal(rejected.rows[0].code, 'unbound_enabled_schedule');
  const repository = new SqliteColdSearchScheduleRepository(dbPath);
  try { assert.equal(repository.listOccurrences(principal.profileId).length, 0); }
  finally { repository.close(); }
});

test('singleton runner lease skips a concurrent tick without claiming work', async t => {
  const dbPath = fixture(t);
  const enabled = await seed(dbPath);
  const repository = new SqliteColdSearchScheduleRepository(dbPath);
  const lease = new SqliteMinuteWorkerLease(repository.db);
  assert.equal(lease.acquire({ owner: 'held-worker', now: enabled.nextRunAt, expiresAt: new Date(Date.parse(enabled.nextRunAt) + 300_000).toISOString() }), true);
  const skipped = cli(dbPath, '--once', enabled.nextRunAt);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.rows[0].event, 'r03.worker.skipped');
  assert.equal(repository.listOccurrences(principal.profileId).length, 0);
  repository.close();
});

test('expired occurrence is quarantined and check reports degraded health', async t => {
  const dbPath = fixture(t);
  const enabled = await seed(dbPath);
  const repository = new SqliteColdSearchScheduleRepository(dbPath);
  const expiresAt = new Date(Date.parse(enabled.nextRunAt) + 60_000).toISOString();
  const [{ occurrence }] = repository.claimDueOccurrences({ now: enabled.nextRunAt, workerId: 'crashed-worker', leaseUntil: expiresAt });
  repository.close();
  const tick = cli(dbPath, '--once', expiresAt);
  assert.equal(tick.status, 2, tick.stderr);
  assert.equal(tick.rows[0].blockedScheduleCount, 1);
  const health = cli(dbPath, '--check', expiresAt);
  assert.equal(health.status, 2, health.stderr);
  assert.equal(health.rows[0].status, 'degraded');
  assert.equal(health.rows[0].blockedScheduleCount, 1);
  const reopened = new SqliteColdSearchScheduleRepository(dbPath);
  try { assert.equal(reopened.getOccurrence(occurrence.occurrenceId).status, 'outcome_unknown'); }
  finally { reopened.close(); }
});

test('restart quarantines an expired durable provider dispatch without calling it again', async t => {
  const dbPath = fixture(t);
  const startedAt = new Date('2026-10-06T00:00:00.000Z');
  let calls = 0;
  let entered;
  const providerEntered = new Promise(resolve => { entered = resolve; });
  const store = new SqliteCandidateSearchJobs({ filename: dbPath, clock: () => new Date(startedAt),
    provider: async () => { calls++; entered(); return new Promise(() => {}); }
  });
  void store.start(principal.profileId, 'recovery-key', request('vac_demo_001'));
  await providerEntered;
  const jobId = store.db.prepare('SELECT job_id FROM candidate_search_jobs').get().job_id;
  store.close();
  const recoveredAt = new Date(startedAt.getTime() + 6 * 60_000).toISOString();
  const health = cli(dbPath, '--check', recoveredAt);
  assert.equal(health.status, 2, health.stderr);
  assert.equal(health.rows[0].expiredDispatchCount, 1);
  const recovered = cli(dbPath, '--once', recoveredAt);
  assert.equal(recovered.status, 2, recovered.stderr);
  assert.equal(recovered.rows[0].recoveredUnknownJobs, 1);
  const reopened = new SqliteCandidateSearchJobs({ filename: dbPath });
  try {
    assert.equal(reopened.get(principal.profileId, jobId).status, 'outcome_unknown');
    assert.equal((await reopened.start(principal.profileId, 'recovery-key', request('vac_demo_001'))).job.status, 'outcome_unknown');
    assert.equal(calls, 1);
  } finally { reopened.close(); }
});

test('one crash leaves occurrence and provider dispatch unknown without replay on later CLI ticks', async t => {
  const dbPath = fixture(t);
  const enabled = await seed(dbPath);
  const dueAt = enabled.nextRunAt;
  const leaseUntil = new Date(Date.parse(dueAt) + 300_000).toISOString();
  const repository = new SqliteColdSearchScheduleRepository(dbPath);
  const [{ occurrence }] = repository.claimDueOccurrences({ now: dueAt, workerId: 'crashed-worker', leaseUntil });
  let providerCalls = 0;
  let entered;
  const providerEntered = new Promise(resolve => { entered = resolve; });
  const store = new SqliteCandidateSearchJobs({ filename: dbPath, clock: () => new Date(dueAt),
    provider: async () => { providerCalls++; entered(); return new Promise(() => {}); }
  });
  const key = `schedule:${occurrence.occurrenceId}`;
  void store.start(principal.profileId, key, request(enabled.vacancyId));
  await providerEntered;
  const jobId = store.db.prepare('SELECT job_id FROM candidate_search_jobs').get().job_id;
  store.close();
  repository.close();

  const recoveredAt = new Date(Date.parse(leaseUntil) + 60_000).toISOString();
  const recovered = cli(dbPath, '--once', recoveredAt);
  assert.equal(recovered.status, 2, recovered.stderr);
  assert.deepEqual([recovered.rows[0].claimed, recovered.rows[0].recoveredUnknownJobs, recovered.rows[0].blockedScheduleCount], [0, 1, 1]);
  const later = cli(dbPath, '--once', new Date(Date.parse(recoveredAt) + 60_000).toISOString());
  assert.equal(later.status, 2, later.stderr);
  assert.deepEqual([later.rows[0].claimed, later.rows[0].recoveredUnknownJobs, later.rows[0].blockedScheduleCount], [0, 0, 1]);

  const reopenedSchedule = new SqliteColdSearchScheduleRepository(dbPath);
  const reopenedJobs = new SqliteCandidateSearchJobs({ filename: dbPath });
  try {
    assert.equal(reopenedSchedule.getOccurrence(occurrence.occurrenceId).status, 'outcome_unknown');
    assert.equal(reopenedSchedule.getSchedule(enabled.scheduleId).blockedByUnknownOccurrenceId, occurrence.occurrenceId);
    assert.equal(reopenedSchedule.listOccurrences(principal.profileId).length, 1);
    assert.equal(reopenedJobs.get(principal.profileId, jobId).status, 'outcome_unknown');
    assert.equal(reopenedJobs.db.prepare('SELECT COUNT(*) AS count FROM candidate_search_jobs').get().count, 1);
    assert.equal((await reopenedJobs.start(principal.profileId, key, request(enabled.vacancyId))).job.status, 'outcome_unknown');
    assert.equal(providerCalls, 1);
  } finally { reopenedJobs.close(); reopenedSchedule.close(); }
});
