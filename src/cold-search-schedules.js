import { createHash } from 'node:crypto';

export const COLD_SEARCH_TIMEZONE = 'Europe/Moscow';
const MINUTE_MS = 60_000;
const moscowFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: COLD_SEARCH_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const digest = value => createHash('sha256').update(value).digest('hex');

function hashOffset(value, mod) {
  let hash = 0;
  for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % mod;
}

export function intervalPlan(intervalHours, vacancyId) {
  const requested = Number(intervalHours) > 0 ? Number(intervalHours) : 24;
  if (requested < 1) return { requestedIntervalHours: requested, intervalHours: 0.5, mode: 'half_hour', minute: hashOffset(vacancyId, 30) };
  if (requested < 24) {
    const hours = [1, 2, 3, 4, 6, 8, 12].reduce((best, value) => Math.abs(value - requested) < Math.abs(best - requested) ? value : best, 1);
    return { requestedIntervalHours: requested, intervalHours: hours, mode: 'hour_step', minute: hashOffset(vacancyId, 60), hourPhase: hashOffset(`${vacancyId}:h`, hours) };
  }
  const days = Math.max(1, Math.round(requested / 24));
  return { requestedIntervalHours: requested, intervalHours: days * 24, mode: 'day_step', days, minute: hashOffset(vacancyId, 60), hour: 7 + hashOffset(`${vacancyId}:h`, 12) };
}

function moscowParts(date) {
  const parts = moscowFormatter.formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function planMatches(plan, date) {
  const { year, month, day, hour, minute } = moscowParts(date);
  void year; void month;
  if (plan.mode === 'half_hour') return minute === plan.minute || minute === plan.minute + 30;
  if (plan.mode === 'hour_step') return minute === plan.minute && hour >= plan.hourPhase && (hour - plan.hourPhase) % plan.intervalHours === 0;
  return minute === plan.minute && hour === plan.hour && (day - 1) % plan.days === 0;
}

export function nextOccurrenceAfter(plan, after, maxSearchDays = 40) {
  const start = Math.floor(new Date(after).getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = start + maxSearchDays * 24 * 60 * MINUTE_MS;
  for (let timestamp = start; timestamp <= end; timestamp += MINUTE_MS) {
    const date = new Date(timestamp);
    if (planMatches(plan, date)) return date.toISOString();
  }
  throw new Error('No schedule occurrence found within bounded search horizon');
}

function latestDueSlot(plan, firstDue, now) {
  const limit = new Date(now).getTime();
  let scheduledAt = firstDue;
  let missedCount = 0;
  // The scan advances by scheduled occurrence, not by minute. The next future
  // slot is also calculated here, so late ticks collapse into one run.
  for (;;) {
    const next = nextOccurrenceAfter(plan, scheduledAt);
    if (new Date(next).getTime() > limit) return { scheduledAt, nextRunAt: next, missedCount };
    scheduledAt = next;
    missedCount++;
    if (missedCount > 200_000) throw new Error('Missed schedule range exceeds safe coalescing bound');
  }
}

function scheduleId(profileId, vacancyId) { return `schedule_demo_${digest(JSON.stringify([profileId, vacancyId])).slice(0, 12)}`; }
function occurrenceKey(legacyJobId, scheduledAt) { return JSON.stringify([legacyJobId, scheduledAt]); }
function occurrenceId(legacyJobId, scheduledAt) { return `occurrence_demo_${digest(occurrenceKey(legacyJobId, scheduledAt)).slice(0, 16)}`; }
const clone = value => structuredClone(value);
function validSearchContext(value, vacancyId) {
  const criteria = value?.criteria;
  return value?.vacancyId === vacancyId && /^criteria-search-demo-r[0-9]+$/.test(value?.criteriaRevision ?? '') && criteria && typeof criteria === 'object' && !Array.isArray(criteria) &&
    Object.keys(criteria).every(key => ['keywords', 'regions'].includes(key)) && Array.isArray(criteria.keywords) && Array.isArray(criteria.regions) &&
    criteria.keywords.length <= 8 && criteria.regions.length <= 8 &&
    criteria.keywords.every(item => typeof item === 'string' && item.length > 0 && item.length <= 100) &&
    criteria.regions.every(item => typeof item === 'string' && /^region_demo_[0-9]{3}$/.test(item));
}

// Test-only adapter with the same atomic method boundary required from a real
// durable repository. Production must implement claim/unique-key writes in one DB transaction.
export class InMemoryColdSearchScheduleRepository {
  schedules = new Map();
  occurrences = new Map();
  occurrenceKeys = new Map();

  upsertSchedule(schedule) { this.schedules.set(schedule.scheduleId, clone(schedule)); return clone(schedule); }
  getSchedule(id) { const value = this.schedules.get(id); return value ? clone(value) : null; }
  listSchedules(profileId) { return [...this.schedules.values()].filter(row => row.profileId === profileId).map(clone); }
  getOccurrence(id) { const value = this.occurrences.get(id); return value ? clone(value) : null; }
  listOccurrences(profileId) { return [...this.occurrences.values()].filter(row => row.profileId === profileId).map(clone); }

  // Atomic transaction boundary: lease check, unique occurrence insert, and
  // next-run advance must be durable together in the production implementation.
  claimDueOccurrences({ now, workerId, leaseUntil }) {
    const nowMs = new Date(now).getTime();
    for (const occurrence of this.occurrences.values()) {
      if (occurrence.status === 'running' && new Date(occurrence.leaseUntil).getTime() <= nowMs) {
        occurrence.status = 'outcome_unknown';
        occurrence.finishedAt = now;
        occurrence.errorCode = 'worker_lease_expired';
        const schedule = this.schedules.get(occurrence.scheduleId);
        if (schedule) {
          schedule.blockedByUnknownOccurrenceId = occurrence.occurrenceId;
          if (schedule.leaseOwner === occurrence.leaseOwner) { schedule.leaseOwner = null; schedule.leaseUntil = null; }
        }
      }
    }
    const claimed = [];
    for (const schedule of this.schedules.values()) {
      if (schedule.blockedByUnknownOccurrenceId) continue;
      if (!schedule.enabled || new Date(schedule.nextRunAt).getTime() > nowMs) continue;
      if (schedule.leaseOwner && new Date(schedule.leaseUntil).getTime() > nowMs) continue;
      const due = latestDueSlot(schedule.plan, schedule.nextRunAt, now);
      const key = occurrenceKey(schedule.legacyJobId, due.scheduledAt);
      const existingId = this.occurrenceKeys.get(key);
      schedule.nextRunAt = due.nextRunAt;
      schedule.leaseOwner = workerId;
      schedule.leaseUntil = leaseUntil;
      if (existingId) { schedule.leaseOwner = null; schedule.leaseUntil = null; continue; }
      const occurrence = {
        occurrenceId: occurrenceId(schedule.legacyJobId, due.scheduledAt),
        scheduleId: schedule.scheduleId, profileId: schedule.profileId, vacancyId: schedule.vacancyId,
        legacyJobId: schedule.legacyJobId, scheduledAt: due.scheduledAt,
        coalescedMissedCount: due.missedCount, criteriaRevision: null, status: 'running', leaseOwner: workerId,
        leaseUntil, startedAt: now, finishedAt: null, errorCode: null, jobId: null, snapshot: null
      };
      this.occurrences.set(occurrence.occurrenceId, occurrence);
      this.occurrenceKeys.set(key, occurrence.occurrenceId);
      claimed.push({ schedule: clone(schedule), occurrence: clone(occurrence) });
    }
    return claimed;
  }

  finishOccurrence(occurrenceIdValue, workerId, result, now) {
    const row = this.occurrences.get(occurrenceIdValue);
    if (!row || row.status !== 'running' || row.leaseOwner !== workerId) return false;
    Object.assign(row, clone(result), { status: result.status, finishedAt: now, leaseOwner: null, leaseUntil: null });
    const schedule = this.schedules.get(row.scheduleId);
    if (schedule) {
      if (result.status === 'outcome_unknown') schedule.blockedByUnknownOccurrenceId = row.occurrenceId;
      if (schedule.leaseOwner === workerId) { schedule.leaseOwner = null; schedule.leaseUntil = null; }
    }
    return true;
  }
}

export function createColdSearchScheduleHandler({ repository, resolveSearchRequest, executeSearch, clock = () => new Date(), leaseMs = 5 * 60_000 }) {
  if (!repository || typeof repository.claimDueOccurrences !== 'function') throw new TypeError('schedule repository port is required');
  if (typeof resolveSearchRequest !== 'function' || typeof executeSearch !== 'function') throw new TypeError('search dependencies are required');

  async function handle(command, trustedContext) {
    if (!trustedContext || typeof trustedContext.profileId !== 'string' || !trustedContext.profileId || !Array.isArray(trustedContext.scopes) || !trustedContext.scopes.includes('recruiting.candidateSearch')) return { kind: 'denied' };
    if (!command || typeof command !== 'object' || Array.isArray(command) || !['enable', 'disable', 'status'].includes(command.action) ||
        Object.keys(command).some(key => !['action', 'vacancyId', 'interval_hours'].includes(key)) ||
        (command.interval_hours !== undefined && (typeof command.interval_hours !== 'number' || !Number.isFinite(command.interval_hours) || command.interval_hours <= 0 || command.interval_hours > 8760))) return { kind: 'invalid_command' };
    const { profileId } = trustedContext;
    if (command.vacancyId !== undefined && !/^vac_demo_[0-9]{3}$/.test(command.vacancyId)) return { kind: 'invalid_vacancy' };
    if (command.action === 'status') {
      const schedules = repository.listSchedules(profileId);
      return { kind: 'status', schedules: command.vacancyId ? schedules.filter(row => row.vacancyId === command.vacancyId) : schedules };
    }
    if (!command.vacancyId) return { kind: 'vacancy_required' };
    const id = scheduleId(profileId, command.vacancyId);
    const existing = repository.getSchedule(id);
    if (command.action === 'disable') {
      if (!existing) return { kind: 'not_found' };
      const updated = { ...existing, enabled: false, updatedAt: clock().toISOString() };
      repository.upsertSchedule(updated);
      return { kind: 'updated', schedule: updated };
    }
    if (existing?.blockedByUnknownOccurrenceId) return { kind: 'outcome_unknown', schedule: existing, occurrenceId: existing.blockedByUnknownOccurrenceId };
    let searchRequest;
    try { searchRequest = await resolveSearchRequest(profileId, command.vacancyId); } catch { searchRequest = null; }
    if (!validSearchContext(searchRequest, command.vacancyId)) return { kind: 'search_context_unavailable' };
    const at = clock().toISOString();
    const plan = intervalPlan(command.interval_hours, command.vacancyId);
    const preserveDueSlot = existing && new Date(existing.nextRunAt).getTime() <= new Date(at).getTime();
    const schedule = {
      scheduleId: id,
      legacyJobId: `cold-search:${digest(profileId).slice(0, 10)}:${command.vacancyId}`,
      profileId, vacancyId: command.vacancyId, enabled: true,
      jobArguments: { vacancyId: command.vacancyId },
      timezone: COLD_SEARCH_TIMEZONE, interval_hours: plan.intervalHours,
      requested_interval_hours: plan.requestedIntervalHours, plan,
      criteriaRevision: searchRequest.criteriaRevision, criteria: clone(searchRequest.criteria),
      nextRunAt: preserveDueSlot ? existing.nextRunAt : nextOccurrenceAfter(plan, at),
      leaseOwner: existing?.leaseOwner ?? null, leaseUntil: existing?.leaseUntil ?? null,
      blockedByUnknownOccurrenceId: existing?.blockedByUnknownOccurrenceId ?? null,
      createdAt: existing?.createdAt ?? at, updatedAt: at
    };
    return { kind: 'updated', schedule: repository.upsertSchedule(schedule) };
  }

  async function tick(workerId = 'synthetic-worker') {
    if (typeof workerId !== 'string' || !workerId) return { claimed: 0, completed: 0, unknown: 0 };
    const now = clock().toISOString();
    const leaseUntil = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const claimed = repository.claimDueOccurrences({ now, workerId, leaseUntil });
    let completed = 0;
    let unknown = 0;
    for (const { schedule, occurrence } of claimed) {
      let currentRequest;
      try { currentRequest = await resolveSearchRequest(schedule.profileId, schedule.vacancyId); } catch { currentRequest = null; }
      if (!validSearchContext(currentRequest, schedule.vacancyId)) {
        repository.finishOccurrence(occurrence.occurrenceId, workerId, { status: 'rejected', errorCode: 'criteria_context_unavailable' }, now);
        continue;
      }
      try {
        const result = await executeSearch({
          profileId: schedule.profileId,
          idempotencyKey: `schedule:${occurrence.occurrenceId}`,
          request: { vacancyId: schedule.vacancyId, criteriaRevision: currentRequest.criteriaRevision, criteria: clone(currentRequest.criteria) }
        });
        if (!result || result.status === 'failed' || result.providerError) {
          const errorCode = result?.providerError?.code ?? 'search_outcome_unknown';
          const status = result?.phase === 'pre_dispatch' ? 'rejected' : 'outcome_unknown';
          repository.finishOccurrence(occurrence.occurrenceId, workerId, { status, criteriaRevision: currentRequest.criteriaRevision, errorCode, jobId: result?.jobId ?? null }, now);
          if (status === 'rejected') continue;
          unknown++;
        } else if (result.status !== 'completed') {
          repository.finishOccurrence(occurrence.occurrenceId, workerId, { status: 'outcome_unknown', criteriaRevision: currentRequest.criteriaRevision, errorCode: 'scheduled_search_incomplete', jobId: result.jobId ?? null }, now);
          unknown++;
        } else {
          const snapshot = { sourceRevision: result.sourceRevision, resultRevision: result.resultRevision, resultCount: result.resultCount, ranking: result.ranking };
          if (repository.finishOccurrence(occurrence.occurrenceId, workerId, { status: 'succeeded', criteriaRevision: currentRequest.criteriaRevision, jobId: result.jobId, snapshot }, now)) completed++;
          else unknown++;
        }
      } catch {
        repository.finishOccurrence(occurrence.occurrenceId, workerId, { status: 'outcome_unknown', criteriaRevision: currentRequest.criteriaRevision, errorCode: 'search_outcome_unknown' }, now);
        unknown++;
      }
    }
    return { claimed: claimed.length, completed, unknown };
  }

  function listOccurrences(trustedContext, vacancyId) {
    if (!trustedContext || typeof trustedContext.profileId !== 'string' || !trustedContext.profileId ||
        !Array.isArray(trustedContext.scopes) || !trustedContext.scopes.includes('recruiting.candidateSearch')) return { kind: 'denied' };
    if (vacancyId !== undefined && !/^vac_demo_[0-9]{3}$/.test(vacancyId)) return { kind: 'invalid_vacancy' };
    const rows = repository.listOccurrences(trustedContext.profileId)
      .filter(row => vacancyId === undefined || row.vacancyId === vacancyId)
      .map(({ leaseOwner, leaseUntil, ...row }) => row);
    return { kind: 'occurrences', occurrences: rows };
  }

  return { handle, listOccurrences, tick };
}
