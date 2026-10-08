import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createColdSearchScheduleHandler } from '../src/cold-search-schedules.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';

const principal = { profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] };
const request = vacancyId => ({
  vacancyId, criteriaRevision: 'criteria-search-demo-r1',
  criteria: { keywords: ['synthetic engineer'], regions: ['region_demo_001'] }
});
const result = { status: 'completed', jobId: 'search_demo_001', sourceRevision: 'source-r1', resultRevision: 'result-r1', resultCount: 1, ranking: 'provider_order_unranked' };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'recruiting-r03-sqlite-'));
  const filename = join(directory, 'schedule.sqlite');
  const opened = [];
  t.after(() => { for (const repository of opened) if (repository.db.open) repository.close(); rmSync(directory, { recursive: true, force: true }); });
  return () => { const repository = new SqliteColdSearchScheduleRepository(filename); opened.push(repository); return repository; };
}

function handler(repository, getTime, executeSearch = async () => result) {
  return createColdSearchScheduleHandler({
    repository, clock: () => new Date(getTime()), leaseMs: 60_000,
    resolveSearchRequest: async (_profileId, vacancyId) => request(vacancyId), executeSearch
  });
}

test('durable schedule survives restart and two SQLite connections claim one occurrence', async t => {
  const open = fixture(t);
  const first = open();
  let now = '2026-10-06T00:00:00.000Z';
  const h1 = handler(first, () => now);
  const enabled = await h1.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal);
  const dueAt = enabled.schedule.nextRunAt;
  first.close();
  // Remove the closed handle from cleanup; reopening the same file is the
  // restart that proves state is not process-local.
  const second = open();
  const third = open();
  const h2 = handler(second, () => now);
  const h3 = handler(third, () => now);
  assert.equal((await h2.handle({ action: 'status' }, principal)).schedules[0].nextRunAt, dueAt);
  now = dueAt;
  const [a, b] = await Promise.all([h2.tick('worker-a'), h3.tick('worker-b')]);
  assert.equal(a.claimed + b.claimed, 1);
  assert.equal(a.completed + b.completed, 1);
  assert.equal(second.listOccurrences(principal.profileId).length, 1);
  assert.equal(third.listOccurrences(principal.profileId)[0].status, 'succeeded');
  assert.equal((await h2.tick('worker-a')).claimed, 0);
  assert.equal((await h3.handle({ action: 'status' }, principal)).schedules[0].nextRunAt > dueAt, true);
});

test('expired lease is quarantined after restart; late finish is fenced and no replay occurs', async t => {
  const open = fixture(t);
  const first = open();
  let now = '2026-10-06T00:00:00.000Z';
  const h1 = handler(first, () => now);
  const enabled = await h1.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal);
  now = enabled.schedule.nextRunAt;
  const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
  const [{ occurrence }] = first.claimDueOccurrences({ now, workerId: 'worker-a', leaseUntil });
  assert.equal(first.claimDueOccurrences({ now, workerId: 'worker-b', leaseUntil }).length, 0);
  // A worker cannot report success after its lease elapsed, even before the
  // next tick materializes the unknown outcome.
  now = leaseUntil;
  assert.equal(first.finishOccurrence(occurrence.occurrenceId, 'worker-a', { status: 'succeeded' }, now), false);
  first.close();
  const second = open();
  const h2 = handler(second, () => now);
  assert.deepEqual(await h2.tick('worker-b'), { claimed: 0, completed: 0, unknown: 0 });
  assert.equal(second.getOccurrence(occurrence.occurrenceId).status, 'outcome_unknown');
  assert.equal(second.getOccurrence(occurrence.occurrenceId).errorCode, 'worker_lease_expired');
  assert.equal(second.getSchedule(enabled.schedule.scheduleId).blockedByUnknownOccurrenceId, occurrence.occurrenceId);
  assert.equal(second.finishOccurrence(occurrence.occurrenceId, 'worker-a', { status: 'succeeded' }, now), false);
  now = new Date(Date.parse(now) + 2 * 60 * 60_000).toISOString();
  assert.equal((await h2.tick('worker-c')).claimed, 0);
  assert.equal(second.listOccurrences(principal.profileId).length, 1);
});

test('occurrence heartbeat extends schedule and occurrence atomically and fences foreign or expired workers', async t => {
  const open = fixture(t);
  const first = open();
  const second = open();
  const enabled = await handler(first, () => '2026-10-06T00:00:00.000Z')
    .handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal);
  const now = enabled.schedule.nextRunAt;
  const initial = new Date(Date.parse(now) + 60_000).toISOString();
  const [{ occurrence }] = first.claimDueOccurrences({ now, workerId: 'worker-a', leaseUntil: initial });
  const later = new Date(Date.parse(now) + 30_000).toISOString();
  const extended = new Date(Date.parse(now) + 90_000).toISOString();
  assert.equal(second.renewOccurrenceLease(occurrence.occurrenceId, 'worker-b', later, extended), false);
  assert.equal(second.renewOccurrenceLease(occurrence.occurrenceId, 'worker-a', later, initial), false);
  assert.equal(second.renewOccurrenceLease(occurrence.occurrenceId, 'worker-a', later, extended), true);
  assert.equal(first.getOccurrence(occurrence.occurrenceId).leaseUntil, extended);
  assert.equal(first.getSchedule(enabled.schedule.scheduleId).leaseUntil, extended);
  assert.equal(first.finishOccurrence(occurrence.occurrenceId, 'worker-a', { status: 'succeeded' }, initial), true);
  assert.equal(second.renewOccurrenceLease(occurrence.occurrenceId, 'worker-a', later, extended), false);
  assert.throws(() => second.renewOccurrenceLease(occurrence.occurrenceId, 'worker-a', later, later),
    /valid occurrence heartbeat required/);
});

test('unique legacy job and scheduled slot prevents duplicate effect and missed slots coalesce', async t => {
  const open = fixture(t);
  const first = open();
  const second = open();
  let now = '2026-10-06T00:00:00.000Z';
  const h = handler(first, () => now);
  const enabled = await h.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal);
  now = new Date(Date.parse(enabled.schedule.nextRunAt) + 3 * 60 * 60_000).toISOString();
  const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
  const [{ occurrence }] = first.claimDueOccurrences({ now, workerId: 'worker-a', leaseUntil });
  assert.equal(occurrence.coalescedMissedCount, 3);
  assert.equal(second.claimDueOccurrences({ now, workerId: 'worker-b', leaseUntil }).length, 0);
  assert.equal(second.finishOccurrence(occurrence.occurrenceId, 'worker-b', { status: 'succeeded' }, now), false);
  assert.equal(first.finishOccurrence(occurrence.occurrenceId, 'worker-a', { status: 'succeeded' }, now), true);
  assert.equal(second.listOccurrences(principal.profileId).length, 1);
  // A stale nextRunAt cannot make the same legacy slot run twice.
  const stale = first.getSchedule(enabled.schedule.scheduleId);
  stale.nextRunAt = occurrence.scheduledAt;
  first.upsertSchedule(stale);
  assert.equal(second.claimDueOccurrences({ now, workerId: 'worker-c', leaseUntil }).length, 0);
  assert.equal(second.listOccurrences(principal.profileId).length, 1);
});

test('late enable cannot rewind nextRunAt after a tick finishes during criteria resolution', async t => {
  const open = fixture(t);
  const repository = open();
  let now = '2026-10-06T00:00:00.000Z';
  let resolveCall = 0;
  let releaseCriteria;
  let markWaiting;
  const waiting = new Promise(resolve => { markWaiting = resolve; });
  const delayedCriteria = new Promise(resolve => { releaseCriteria = resolve; });
  const schedule = createColdSearchScheduleHandler({
    repository, clock: () => new Date(now), leaseMs: 60_000,
    resolveSearchRequest: async (_profileId, vacancyId) => {
      if (++resolveCall === 2) { markWaiting(); await delayedCriteria; }
      return request(vacancyId);
    },
    executeSearch: async () => result
  });
  const enabled = await schedule.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal);
  now = enabled.schedule.nextRunAt;
  const lateEnable = schedule.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal);
  await waiting;
  assert.equal((await schedule.tick('worker-a')).completed, 1);
  const advancedAt = repository.getSchedule(enabled.schedule.scheduleId).nextRunAt;
  assert.equal(advancedAt > now, true);
  releaseCriteria();
  const updated = await lateEnable;
  assert.equal(updated.schedule.nextRunAt, advancedAt);
  assert.equal(repository.getSchedule(enabled.schedule.scheduleId).nextRunAt, advancedAt);
  assert.equal((await schedule.tick('worker-b')).claimed, 0);
});

test('SQLite refuses a shared directory so WAL and SHM remain private', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recruiting-r03-mode-'));
  try {
    chmodSync(directory, 0o755);
    assert.throws(() => new SqliteColdSearchScheduleRepository(join(directory, 'schedule.sqlite')), /owner-only/);
    chmodSync(directory, 0o700);
    const repository = new SqliteColdSearchScheduleRepository(join(directory, 'schedule.sqlite'));
    assert.equal(statSync(directory).mode & 0o077, 0);
    assert.equal(statSync(join(directory, 'schedule.sqlite')).mode & 0o077, 0);
    repository.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
