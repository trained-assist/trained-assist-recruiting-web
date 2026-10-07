import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { SqliteMinuteWorkerLease } from '../src/sqlite-minute-worker-lease.js';
import { runPrivateHhMinuteTick } from '../src/r03-private-minute-tick.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'r03-private-minute-'));
  const repo = new SqliteColdSearchScheduleRepository(join(dir, 'private.sqlite'));
  t.after(() => { if (repo.db.open) repo.close(); rmSync(dir, { recursive: true, force: true }); });
  return repo;
}

test('host lease renews during a long tick; overlapping process skips without dispatch', async t => {
  const repo = fixture(t);
  const worker = { tick: async () => {
    await new Promise(resolve => setTimeout(resolve, 180));
    return { claimed: 1, completed: 1, rejected: 0, unknown: 0 };
  } };
  const first = runPrivateHhMinuteTick({ worker, scheduleRepository: repo,
    workerId: 'worker_first', leaseMs: 70, heartbeatMs: 15 });
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.deepEqual(await runPrivateHhMinuteTick({ worker, scheduleRepository: repo,
    workerId: 'worker_second', leaseMs: 70, heartbeatMs: 15 }),
  { status: 'skipped', reason: 'timer_busy' });
  assert.deepEqual(await first, { status: 'completed',
    result: { claimed: 1, completed: 1, rejected: 0, unknown: 0 } });
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM r03_minute_worker_lease').get().n, 0);
});

test('foreign, expired and deleted singleton leases cannot be renewed', async t => {
  const repo = fixture(t);
  const lease = new SqliteMinuteWorkerLease(repo.db);
  const now = '2026-10-06T00:00:00.000Z';
  const first = '2026-10-06T00:01:00.000Z';
  const extended = '2026-10-06T00:02:00.000Z';
  assert.equal(lease.acquire({ owner: 'worker_first', now, expiresAt: first }), true);
  assert.equal(lease.renew({ owner: 'worker_other', now, expiresAt: extended }), false);
  assert.equal(lease.renew({ owner: 'worker_first', now, expiresAt: extended }), true);
  assert.equal(lease.renew({ owner: 'worker_first', now, expiresAt: extended }), false);
  assert.equal(lease.renew({ owner: 'worker_first', now: extended, expiresAt: '2026-10-06T00:03:00.000Z' }), false);
  assert.equal(lease.release('worker_other'), false);
  assert.equal(lease.release('worker_first'), true);
  assert.equal(lease.renew({ owner: 'worker_first', now, expiresAt: extended }), false);
});

test('lost singleton lease reports loss and never releases another owner', async t => {
  const repo = fixture(t);
  const worker = { tick: async () => {
    repo.db.prepare('UPDATE r03_minute_worker_lease SET owner = ?').run('worker_other');
    await new Promise(resolve => setTimeout(resolve, 40));
    return { claimed: 0, completed: 0, unknown: 0 };
  } };
  const outcome = await runPrivateHhMinuteTick({ worker, scheduleRepository: repo,
    workerId: 'worker_first', leaseMs: 100, heartbeatMs: 10 });
  assert.equal(outcome.status, 'lease_lost');
  assert.equal(repo.db.prepare('SELECT owner FROM r03_minute_worker_lease').get().owner, 'worker_other');
});
