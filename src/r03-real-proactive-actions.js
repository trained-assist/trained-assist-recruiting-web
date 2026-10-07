import { createHash } from 'node:crypto';
import { intervalPlan, nextOccurrenceAfter, COLD_SEARCH_TIMEZONE } from './cold-search-schedules.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));

export function createR03RealProactiveActions({ scheduleRepository, manualRuns, feed, loadSearchPlan,
  isVacancyOwned, clock = () => new Date() }) {
  if (typeof scheduleRepository?.listSchedules !== 'function' || typeof scheduleRepository?.upsertSchedule !== 'function' ||
      typeof scheduleRepository?.listOccurrences !== 'function' || typeof manualRuns?.start !== 'function' ||
      typeof manualRuns?.get !== 'function' || typeof feed?.read !== 'function' || typeof feed?.update !== 'function' ||
      typeof loadSearchPlan !== 'function' || typeof isVacancyOwned !== 'function' || typeof clock !== 'function')
    throw new TypeError('real proactive action ports required');
  const deny = { status: 404, body: { error: 'vacancy_not_found' } };
  const scope = (context, vacancyId) => safeId(context?.profileId) && context.scopes?.includes('recruiting.candidateSearch') &&
    safeId(vacancyId) && isVacancyOwned(context.profileId, vacancyId);
  const scheduleFor = (profileId, vacancyId) => {
    const rows = scheduleRepository.listSchedules(profileId).filter(row => row.vacancyId === vacancyId);
    if (rows.length > 1) throw new Error('duplicate_vacancy_schedule');
    return rows[0] ?? null;
  };
  return {
    scheduleStatus(context, vacancyId) {
      if (!scope(context, vacancyId)) return deny;
      return { status: 200, body: { ok: true, schedules: scheduleRepository.listSchedules(context.profileId).filter(row => row.vacancyId === vacancyId) } };
    },
    occurrences(context, vacancyId) {
      if (!scope(context, vacancyId)) return deny;
      return { status: 200, body: { ok: true, occurrences: scheduleRepository.listOccurrences(context.profileId).filter(row => row.vacancyId === vacancyId) } };
    },
    async updateSchedule(context, command) {
      if (!exact(command, ['vacancy_id', 'action', 'interval_hours']) || !scope(context, command.vacancy_id) ||
          !['enable', 'disable'].includes(command.action) ||
          command.action === 'disable' && command.interval_hours !== undefined ||
          command.action === 'enable' && (!Number.isFinite(command.interval_hours) || command.interval_hours < 0.5 || command.interval_hours > 8760))
        return { status: 400, body: { error: 'invalid_schedule_action' } };
      const { profileId } = context;
      const vacancyId = command.vacancy_id;
      const existing = scheduleFor(profileId, vacancyId);
      if (command.action === 'disable') {
        if (!existing) return { status: 404, body: { error: 'schedule_not_found' } };
        const updated = scheduleRepository.upsertSchedule({ ...existing, enabled: false, updatedAt: clock().toISOString() }, existing.nextRunAt);
        return { status: 200, body: { ok: true, schedule: updated } };
      }
      if (existing?.blockedByUnknownOccurrenceId)
        return { status: 409, body: { error: 'schedule_blocked_by_unknown', occurrenceId: existing.blockedByUnknownOccurrenceId } };
      let plan;
      try { plan = await loadSearchPlan(profileId, vacancyId); } catch { plan = null; }
      if (plan?.profileId !== profileId || plan?.vacancyId !== vacancyId ||
          typeof plan?.criteriaRevision !== 'string' || !plan.criteriaRevision ||
          typeof plan?.queryCache?.revision !== 'string' || !plan.queryCache.revision)
        return { status: 503, body: { error: 'search_plan_unavailable' } };
      const now = clock().toISOString();
      const cadence = intervalPlan(command.interval_hours, vacancyId);
      const scheduleId = existing?.scheduleId ?? `schedule_real_${hash([profileId, vacancyId]).slice(0, 24)}`;
      const schedule = scheduleRepository.upsertSchedule({
        scheduleId, legacyJobId: existing?.legacyJobId ?? `cold-search:${hash(profileId).slice(0, 10)}:${vacancyId}`,
        profileId, vacancyId, enabled: true, plan: cadence, timezone: COLD_SEARCH_TIMEZONE,
        jobArguments: { vacancyId }, criteriaRevision: plan.criteriaRevision,
        nextRunAt: existing && existing.nextRunAt <= now ? existing.nextRunAt : nextOccurrenceAfter(cadence, now),
        leaseOwner: existing?.leaseOwner ?? null, leaseUntil: existing?.leaseUntil ?? null,
        blockedByUnknownOccurrenceId: existing?.blockedByUnknownOccurrenceId ?? null,
        createdAt: existing?.createdAt ?? now, updatedAt: now
      }, existing?.nextRunAt ?? null);
      return { status: 200, body: { ok: true, schedule } };
    },
    async manualStart(context, command, idempotencyKey) {
      if (!exact(command, ['vacancy_id']) || !scope(context, command.vacancy_id) || !safeId(idempotencyKey))
        return { status: 400, body: { error: 'invalid_manual_search' } };
      let plan;
      try { plan = await loadSearchPlan(context.profileId, command.vacancy_id); } catch { plan = null; }
      if (plan?.profileId !== context.profileId || plan?.vacancyId !== command.vacancy_id ||
          !plan.criteriaRevision || !plan.queryCache?.revision)
        return { status: 503, body: { error: 'search_plan_unavailable' } };
      const result = await manualRuns.start(context, idempotencyKey, { vacancyId: command.vacancy_id,
        criteriaRevision: plan.criteriaRevision, queryRevision: plan.queryCache.revision });
      return result.kind === 'created' ? { status: 202, body: { ok: true, run: result.run } } :
        result.kind === 'replay' ? { status: 200, body: { ok: true, run: result.run } } :
        result.kind === 'conflict' ? { status: 409, body: { error: 'idempotency_conflict' } } :
        { status: 503, body: { error: 'manual_search_unavailable' } };
    },
    manualGet(context, runId) {
      const result = manualRuns.get(context, runId);
      if (result.kind !== 'found') return { status: result.kind === 'denied' ? 403 : 404,
        body: { error: result.kind === 'denied' ? 'search_scope_required' : 'run_not_found' } };
      if (!scope(context, result.run.vacancyId)) return deny;
      return { status: 200, body: { ok: true, run: result.run } };
    },
    updateCandidate(context, vacancyId, candidateId, command) {
      if (!scope(context, vacancyId)) return deny;
      if (!safeId(candidateId) || !exact(command, ['expected_revision', 'status', 'comment', 'exclude_from_search']) ||
          !Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0 ||
          command.status !== undefined && !['active', 'starred', 'archived'].includes(command.status) ||
          command.comment !== undefined && command.comment !== null &&
            (typeof command.comment !== 'string' || command.comment.length > 1000) ||
          command.exclude_from_search !== undefined && typeof command.exclude_from_search !== 'boolean')
        return { status: 400, body: { error: 'invalid_candidate_action' } };
      const item = feed.read(context, vacancyId).items.find(candidate => candidate.id === candidateId);
      if (!item) return { status: 404, body: { error: 'candidate_not_found' } };
      const result = feed.update(context, vacancyId, candidateId, {
        expectedRevision: command.expected_revision, status: command.status ?? item.review.status,
        comment: command.comment === undefined ? item.comment : command.comment,
        excludeFromSearch: command.exclude_from_search ?? item.excludeFromSearch
      });
      return result.kind === 'updated' ? { status: 200, body: { ok: true, revision: result.revision } } :
        { status: 409, body: { error: 'review_revision_conflict', currentRevision: result.currentRevision } };
    }
  };
}
