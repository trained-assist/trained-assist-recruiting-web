// A timer invocation has one shared five-minute dispatch budget across every
// bound profile/vacancy. Accepted receipts, not enabled schedules, select work.
export async function runAcceptedAssessmentWorker({ queue, scopes, workerId,
  clock = () => new Date(), maxDurationMs = 285_000 } = {}) {
  if (typeof queue?.tick !== 'function' || typeof queue?.remainingDispatches !== 'function' ||
      !Array.isArray(scopes) || typeof workerId !== 'string' || !workerId ||
      typeof clock !== 'function' || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 50_000)
    throw new TypeError('accepted_assessment_worker_ports_required');
  const deadlineMs = clock().getTime() + maxDurationMs;
  const totals = { scopes: scopes.length, claimed: 0, written: 0, deferred: 0,
    blocked: 0, unknown: 0, inserted: 0, acceptedJobs: 0 };
  const acceptedByScope = new Map();
  const due = [...scopes];
  while (due.length && queue.remainingDispatches() > 0 && clock().getTime() + 50_000 <= deadlineMs) {
    const scope = due.shift();
    const quota = Math.ceil(queue.remainingDispatches() / (due.length + 1));
    const result = await queue.tick(scope.profileId, scope.vacancyId, workerId, quota, { deadlineMs });
    for (const field of ['claimed', 'written', 'deferred', 'blocked', 'unknown', 'inserted'])
      totals[field] += result[field];
    acceptedByScope.set(`${scope.profileId}\0${scope.vacancyId}`, result.acceptedJobs);
    if (result.claimed) due.push(scope);
  }
  totals.acceptedJobs = [...acceptedByScope.values()].reduce((sum, count) => sum + count, 0);
  return { status: totals.unknown || totals.blocked ? 'degraded' : 'completed',
    ...totals, budgetRemaining: queue.remainingDispatches() };
}
