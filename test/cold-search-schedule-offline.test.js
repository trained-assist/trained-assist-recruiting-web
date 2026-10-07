import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createRecruitingServer } from '../src/server.js';
import { syntheticColdSearchProvider } from '../src/candidate-search-jobs.js';
import { COLD_SEARCH_TIMEZONE, InMemoryColdSearchScheduleRepository, createColdSearchScheduleHandler, intervalPlan } from '../src/cold-search-schedules.js';

const principal = profileId => ({ profileId, scopes: ['recruiting.candidateSearch'] });
const request = { vacancyId: 'vac_demo_001', criteriaRevision: 'criteria-search-demo-r1', criteria: { keywords: ['synthetic engineer'], regions: ['region_demo_001'] } };

test('offline schedule entrypoint shares the manual search handler, fixture result store, and trusted profile scope', async () => {
  const commandSchema = JSON.parse(await readFile(new URL('../contracts/v1-cold-search-schedule-command.schema.json', import.meta.url), 'utf8'));
  const validateCommand = new Ajv2020({ allErrors: true }).compile(commandSchema);
  assert.equal(validateCommand({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 6 }), true);
  assert.equal(validateCommand({ action: 'enable', vacancyId: 'vac_demo_001', profileId: 'profile_demo_001' }), false);
  assert.equal(validateCommand({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 0 }), false);
  const criteriaByProfile = new Map([
    ['profile_demo_001', request],
    ['profile_demo_002', request]
  ]);
  let currentRequest = request;
  let pageTwoFailures = 1;
  let providerCalls = 0;
  let current = new Date('2026-10-06T00:00:00.000Z');
  const scheduleRepository = new InMemoryColdSearchScheduleRepository();
  const runtimeSources = await Promise.all(['../src/server.js', '../src/cold-search-schedules.js', '../src/candidate-search-jobs.js'].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const source of runtimeSources) {
    assert.doesNotMatch(source, /(?:launchAgentRun|runAgent|runMcpTool|spawnAgent|codex\s+exec|claude\s+-p)/i, 'schedule/search runtime cannot launch an agent run');
    const importedPackages = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]).filter(specifier => !specifier.startsWith('node:') && !specifier.startsWith('.'));
    assert.deepEqual(importedPackages, [], 'offline runtime imports only Node built-ins and local domain modules');
  }
  const server = createRecruitingServer({
    resolveTrustedProfileContext: req => req.headers['x-test-principal'] ? principal(req.headers['x-test-principal']) : null,
    resolveCurrentSearchCriteriaRevision: () => currentRequest.criteriaRevision,
    resolveScheduledSearchRequest: async (profileId, vacancyId) => vacancyId === request.vacancyId ? criteriaByProfile.get(profileId) ?? null : null,
    candidateSearchProvider: async input => {
      providerCalls++;
      if (input.cursor === 'fixture-page-2' && pageTwoFailures-- > 0) return { kind: 'error', code: 'provider_unavailable', retryable: true };
      return syntheticColdSearchProvider(input);
    },
    candidateSearchScheduleRepository: scheduleRepository,
    scheduleClock: () => new Date(current)
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const manualResponse = await fetch(`${base}/api/v1/ui/candidate-searches`, {
      method: 'POST', headers: { 'X-Test-Principal': 'profile_demo_001', 'Idempotency-Key': 'manual-offline-001', 'Content-Type': 'application/json' }, body: JSON.stringify(request)
    });
    const manualJob = await manualResponse.json();
    assert.equal(manualResponse.status, 202);
    const enabled = await server.coldSearchSchedules.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 6 }, principal('profile_demo_001'));
    assert.equal(enabled.kind, 'updated');
    assert.equal(enabled.schedule.timezone, 'Europe/Moscow');
    assert.equal(enabled.schedule.interval_hours, 6);
    assert.deepEqual(enabled.schedule.jobArguments, { vacancyId: 'vac_demo_001' });
    assert.doesNotMatch(JSON.stringify(enabled.schedule.jobArguments), /token|profile/i, 'legacy job arguments omit credentials and profile identity');
    assert.deepEqual(await server.coldSearchSchedules.handle({ action: 'status' }, principal('profile_demo_002')), { kind: 'status', schedules: [] });
    assert.equal((await server.coldSearchSchedules.handle({ action: 'disable', vacancyId: 'vac_demo_001' }, principal('profile_demo_002'))).kind, 'not_found');
    assert.equal((await server.coldSearchSchedules.handle({ action: 'enable', vacancyId: 'vac_demo_001' }, { profileId: 'profile_demo_001', scopes: [] })).kind, 'denied');
    assert.equal((await server.coldSearchSchedules.handle({ action: 'enable', vacancyId: 'vac_demo_001', profileId: 'profile_demo_002' }, principal('profile_demo_001'))).kind, 'invalid_command');

    const occurrenceAt = enabled.schedule.nextRunAt;
    current = new Date(occurrenceAt);
    const reenabled = await server.coldSearchSchedules.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 6 }, principal('profile_demo_001'));
    assert.equal(reenabled.schedule.nextRunAt, occurrenceAt, 'reenabling an already-due schedule preserves the due slot for coalesced execution');
    const searchStatus = await fetch(`${base}/api/v1/ui/candidate-searches/${manualJob.jobId}`, { headers: { 'X-Test-Principal': 'profile_demo_001' } });
    assert.equal(searchStatus.status, 200);
    assert.equal((await searchStatus.json()).resultCount, 2);
    const snapshotPage = await fetch(`${base}/api/v1/ui/candidate-searches/${manualJob.jobId}/results?limit=10`, { headers: { 'X-Test-Principal': 'profile_demo_001' } });
    assert.equal((await snapshotPage.json()).items[0].candidateRef, 'candidate_search_demo_001');
    currentRequest = { vacancyId: 'vac_demo_001', criteriaRevision: 'criteria-search-demo-r2', criteria: { keywords: ['fresh synthetic criterion'], regions: ['region_demo_002'] } };
    criteriaByProfile.set('profile_demo_001', currentRequest);
    const tick = await server.coldSearchSchedules.tick('offline-worker');
    assert.deepEqual(tick, { claimed: 1, completed: 1, unknown: 0 });
    const [scheduledOccurrence] = scheduleRepository.listOccurrences('profile_demo_001');
    assert.equal(scheduledOccurrence.status, 'succeeded');
    assert.equal(scheduledOccurrence.criteriaRevision, 'criteria-search-demo-r2', 'due worker refreshes current profile/vacancy criteria after schedule enable');
    const scheduledStatus = await fetch(`${base}/api/v1/ui/candidate-searches/${scheduledOccurrence.jobId}`, { headers: { 'X-Test-Principal': 'profile_demo_001' } });
    assert.equal(scheduledStatus.status, 200, 'scheduled run uses the same route-visible search job store');
    const scheduledJob = await scheduledStatus.json();
    assert.equal(scheduledJob.status, 'completed', 'scheduled execution resumes all provider pages');
    assert.equal(scheduledJob.criteriaRevision, 'criteria-search-demo-r2');
    assert.equal(scheduledJob.resultCount, 3);
    assert.equal(providerCalls, 4, 'retryable error between fixture pages is resumed in the same occurrence');
    const status = await server.coldSearchSchedules.handle({ action: 'status', vacancyId: 'vac_demo_001' }, principal('profile_demo_001'));
    assert.equal(status.schedules[0].nextRunAt > occurrenceAt, true);
    // Scheduled and manual runs both land in the same candidate-search domain map.
    const ownStatus = await server.coldSearchSchedules.handle({ action: 'status' }, principal('profile_demo_001'));
    const schedule = ownStatus.schedules[0];
    assert.equal(schedule.legacyJobId.startsWith('cold-search:'), true);
    assert.equal(schedule.timezone, COLD_SEARCH_TIMEZONE);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('minute tick claims unique occurrences, coalesces downtime, leases overlap, and never blindly replays unknown work', async () => {
  let current = new Date('2026-10-06T00:00:00.000Z');
  const repository = new InMemoryColdSearchScheduleRepository();
  let entered;
  let gateRelease;
  let executions = 0;
  let makeUnknown = false;
  const schedule = createColdSearchScheduleHandler({
    repository,
    clock: () => new Date(current),
    leaseMs: 60_000,
    resolveSearchRequest: async (_profileId, vacancyId) => ({ ...request, vacancyId }),
    executeSearch: async () => {
      executions++;
      if (makeUnknown) { makeUnknown = false; throw new Error('ambiguous fake provider outcome'); }
      if (gateRelease) { entered(); await new Promise(resolve => { gateRelease = resolve; }); }
      return { jobId: 'search_demo_abcdef123456', status: 'completed', sourceRevision: 'cold-search-provider-demo-r1', resultRevision: 'abcdef0123456789', resultCount: 2, ranking: 'provider_order_unranked' };
    }
  });
  const enabled = await schedule.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal('profile_demo_001'));
  assert.equal(enabled.kind, 'updated');
  const dueAt = enabled.schedule.nextRunAt;
  current = new Date(dueAt);
  let holdNext = true;
  if (holdNext) {
    entered = () => startedResolve();
    let startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    gateRelease = () => {};
    const first = schedule.tick('worker-a');
    await started;
    const overlap = await schedule.tick('worker-b');
    assert.deepEqual(overlap, { claimed: 0, completed: 0, unknown: 0 });
    current = new Date(new Date(dueAt).getTime() + 30_000);
    gateRelease();
    await first;
    gateRelease = null;
    holdNext = false;
  }
  const firstOccurrence = repository.listOccurrences('profile_demo_001')[0];
  assert.equal(firstOccurrence.status, 'succeeded');
  assert.equal(firstOccurrence.legacyJobId, enabled.schedule.legacyJobId);
  assert.equal(firstOccurrence.scheduledAt, dueAt);
  assert.equal(firstOccurrence.finishedAt, current.toISOString(), 'finish time reflects provider completion after the tick began');
  const occurrenceSchema = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../contracts/v1-cold-search-occurrence.schema.json', import.meta.url), 'utf8'));
  const validateOccurrence = new Ajv2020({ allErrors: true }).compile(occurrenceSchema);
  const publicOccurrence = Object.fromEntries(Object.entries(firstOccurrence).filter(([key]) => key !== 'scheduleId' && key !== 'profileId' && key !== 'leaseOwner' && key !== 'leaseUntil'));
  assert.equal(validateOccurrence(publicOccurrence), true, JSON.stringify(validateOccurrence.errors));

  current = new Date(new Date(dueAt).getTime() + 3 * 60 * 60_000 + 5_000);
  const catchup = await schedule.tick('worker-c');
  assert.equal(catchup.claimed, 1);
  const afterCatchup = repository.listOccurrences('profile_demo_001');
  assert.equal(afterCatchup.length, 2, 'several missed due slots create one coalesced occurrence');
  assert.ok(afterCatchup[1].coalescedMissedCount >= 1);

  const dueUnknown = repository.getSchedule(enabled.schedule.scheduleId).nextRunAt;
  current = new Date(dueUnknown);
  makeUnknown = true;
  const callsBeforeUnknown = executions;
  assert.deepEqual(await schedule.tick('worker-d'), { claimed: 1, completed: 0, unknown: 1 });
  const unknown = repository.listOccurrences('profile_demo_001').find(row => row.scheduledAt === dueUnknown);
  assert.equal(unknown.status, 'outcome_unknown');
  assert.deepEqual(await schedule.tick('worker-e'), { claimed: 0, completed: 0, unknown: 0 });
  assert.equal(executions, callsBeforeUnknown + 1, 'unknown occurrence is not replayed on the next tick');
  assert.equal((await schedule.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal('profile_demo_001'))).kind, 'outcome_unknown', 're-enable cannot clear an unresolved occurrence quarantine');
  const leaseSchedule = await schedule.handle({ action: 'enable', vacancyId: 'vac_demo_002', interval_hours: 1 }, principal('profile_demo_003'));
  current = new Date(leaseSchedule.schedule.nextRunAt);
  let leaseEnteredResolve;
  const leaseEntered = new Promise(resolve => { leaseEnteredResolve = resolve; });
  entered = () => leaseEnteredResolve();
  gateRelease = () => {};
  const runningPastLease = schedule.tick('long-running-worker');
  await leaseEntered;
  const inFlightOccurrence = repository.listOccurrences('profile_demo_003')[0];
  current = new Date(new Date(inFlightOccurrence.leaseUntil).getTime() + 1);
  const callsBeforeExpiredLease = executions;
  assert.deepEqual(await schedule.tick('recovery-worker'), { claimed: 0, completed: 0, unknown: 0 });
  assert.equal(repository.getOccurrence(inFlightOccurrence.occurrenceId).status, 'outcome_unknown', 'expired running lease requires reconciliation rather than replay');
  assert.equal(executions, callsBeforeExpiredLease, 'an expired lease does not permit a second overlapping search');
  gateRelease();
  await runningPastLease;
  const leaseAfter = repository.getSchedule(leaseSchedule.schedule.scheduleId);
  current = new Date(new Date(leaseAfter.nextRunAt).getTime() + 1);
  assert.deepEqual(await schedule.tick('later-worker'), { claimed: 0, completed: 0, unknown: 0 }, 'schedule remains quarantined after ambiguous running work');
  assert.equal(executions, callsBeforeExpiredLease);
  assert.deepEqual(await runningPastLease, { claimed: 1, completed: 0, unknown: 1 }, 'a late completion cannot overwrite the quarantined occurrence');
  const anotherProfile = await schedule.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal('profile_demo_002'));
  assert.notEqual(anotherProfile.schedule.legacyJobId, enabled.schedule.legacyJobId);
  assert.equal(intervalPlan(5, 'vac_demo_001').intervalHours, 4, 'legacy interval mapping snaps to the nearest supported interval');
  assert.deepEqual(intervalPlan(6, 'vac_demo_001'), intervalPlan(6, 'vac_demo_001'), 'vacancy phase is deterministic');
  assert.notDeepEqual(intervalPlan(6, 'vac_demo_001'), intervalPlan(6, 'vac_demo_002'), 'vacancies receive distinct spread phases');
  const anotherVacancy = await schedule.handle({ action: 'enable', vacancyId: 'vac_demo_003', interval_hours: 1 }, principal('profile_demo_003'));
  assert.notEqual(anotherVacancy.schedule.scheduleId, leaseSchedule.schedule.scheduleId);
  assert.equal(repository.listSchedules('profile_demo_003').length, 2, 'one profile can own distinct vacancy schedules without cross-collision');
});

test('resolver vacancy mismatch and known pre-dispatch stale criteria are rejected without unknown quarantine', async () => {
  let current = new Date('2026-10-06T00:00:00.000Z');
  const repository = new InMemoryColdSearchScheduleRepository();
  let resolverVacancy = 'vac_demo_001';
  let executions = 0;
  const handler = createColdSearchScheduleHandler({
    repository, clock: () => new Date(current),
    resolveSearchRequest: async () => ({ ...request, vacancyId: resolverVacancy }),
    executeSearch: async () => { executions++; return { status: 'failed', phase: 'pre_dispatch', providerError: { code: 'stale_search_criteria' } }; }
  });
  resolverVacancy = 'vac_demo_002';
  assert.equal((await handler.handle({ action: 'enable', vacancyId: 'vac_demo_001' }, principal('profile_demo_001'))).kind, 'search_context_unavailable');
  assert.equal(repository.listSchedules('profile_demo_001').length, 0, 'mismatched context cannot create a schedule');
  resolverVacancy = 'vac_demo_001';
  const enabled = await handler.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal('profile_demo_001'));
  current = new Date(enabled.schedule.nextRunAt);
  resolverVacancy = 'vac_demo_002';
  assert.deepEqual(await handler.tick('worker-mismatch'), { claimed: 1, completed: 0, unknown: 0 });
  const [mismatched] = repository.listOccurrences('profile_demo_001');
  assert.equal(mismatched.status, 'rejected');
  assert.equal(mismatched.errorCode, 'criteria_context_unavailable');
  assert.equal(executions, 0, 'vacancy mismatch is rejected before dispatch');
  assert.equal(repository.getSchedule(enabled.schedule.scheduleId).blockedByUnknownOccurrenceId, null);

  resolverVacancy = 'vac_demo_001';
  const staleRepo = new InMemoryColdSearchScheduleRepository();
  const staleHandler = createColdSearchScheduleHandler({
    repository: staleRepo, clock: () => new Date(current),
    resolveSearchRequest: async () => ({ ...request, vacancyId: 'vac_demo_001' }),
    executeSearch: async () => { executions++; return { status: 'failed', phase: 'pre_dispatch', providerError: { code: 'stale_search_criteria' } }; }
  });
  const staleEnabled = await staleHandler.handle({ action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 1 }, principal('profile_demo_002'));
  current = new Date(staleEnabled.schedule.nextRunAt);
  assert.deepEqual(await staleHandler.tick('worker-stale'), { claimed: 1, completed: 0, unknown: 0 });
  const [stale] = staleRepo.listOccurrences('profile_demo_002');
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.errorCode, 'stale_search_criteria');
  assert.equal(staleRepo.getSchedule(staleEnabled.schedule.scheduleId).blockedByUnknownOccurrenceId, null);
  assert.equal(executions, 1, 'stale rejection is a known pre-dispatch failure');

  const capacityRepo = new InMemoryColdSearchScheduleRepository();
  const capacityHandler = createColdSearchScheduleHandler({
    repository: capacityRepo, clock: () => new Date(current),
    resolveSearchRequest: async (_profileId, vacancyId) => ({ ...request, vacancyId }),
    executeSearch: async () => ({ status: 'failed', phase: 'pre_dispatch', providerError: { code: 'job_capacity_reached' } })
  });
  const capacitySchedule = await capacityHandler.handle({ action: 'enable', vacancyId: 'vac_demo_003', interval_hours: 1 }, principal('profile_demo_003'));
  current = new Date(capacitySchedule.schedule.nextRunAt);
  assert.deepEqual(await capacityHandler.tick('worker-capacity'), { claimed: 1, completed: 0, unknown: 0 });
  const [capacity] = capacityRepo.listOccurrences('profile_demo_003');
  assert.equal(capacity.status, 'rejected');
  assert.equal(capacity.errorCode, 'job_capacity_reached');
  assert.equal(capacityRepo.getSchedule(capacitySchedule.schedule.scheduleId).blockedByUnknownOccurrenceId, null);
});
