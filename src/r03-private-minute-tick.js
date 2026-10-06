import { SqliteMinuteWorkerLease } from './sqlite-minute-worker-lease.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// One externally triggered minute tick. The host owns schedule installation,
// private configuration and watchdog. This wrapper prevents overlapping runs
// across processes while the occurrence repository fences each HH effect.
export async function runPrivateHhMinuteTick({ worker, scheduleRepository, workerId,
  clock = () => new Date(), leaseMs = 5 * 60_000,
  heartbeatMs = Math.min(60_000, Math.floor(leaseMs / 3)) } = {}) {
  if (typeof worker?.tick !== 'function' || !scheduleRepository?.db || !safeId(workerId) ||
      typeof clock !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 3 ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= leaseMs)
    throw new TypeError('private minute tick ports required');
  const lease = new SqliteMinuteWorkerLease(scheduleRepository.db);
  const now = clock().toISOString();
  if (!lease.acquire({ owner: workerId, now,
    expiresAt: new Date(Date.parse(now) + leaseMs).toISOString() }))
    return { status: 'skipped', reason: 'timer_busy' };
  let lost = false;
  const heartbeat = setInterval(() => {
    try {
      const at = clock().toISOString();
      if (!lease.renew({ owner: workerId, now: at,
          expiresAt: new Date(Date.parse(at) + leaseMs).toISOString() })) lost = true;
    } catch { lost = true; }
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    const result = await worker.tick(workerId);
    return lost ? { status: 'lease_lost', result } :
      { status: result?.unknown > 0 ? 'degraded' : 'completed', result };
  } finally {
    clearInterval(heartbeat);
    lease.release(workerId);
  }
}
