#!/usr/bin/env node
// Public sandbox only: fixed synthetic profile, fake search provider, in-memory state.
// Never point this adapter at real profile data or a live HH provider.
import { createRecruitingServer } from '../src/server.js';
import { syntheticColdSearchProvider } from '../src/candidate-search-jobs.js';

const profileId = 'profile_demo_001';
const vacancyId = 'vac_demo_001';
const context = {
  profileId,
  scopes: ['recruiting.profile.read', 'recruiting.responses.read', 'recruiting.candidateSearch']
};
let clock = new Date();
let tickInProgress = false;

const server = createRecruitingServer({
  // Public sandbox authority is deliberately pinned to one invented profile.
  // Request headers and query parameters never select this profile.
  resolveTrustedProfileContext: async () => context,
  resolveCurrentSearchCriteriaRevision: async () => 'criteria-search-demo-r1',
  resolveScheduledSearchRequest: async (requestedProfile, requestedVacancy) =>
    requestedProfile === profileId && requestedVacancy === vacancyId
      ? {
          vacancyId,
          criteriaRevision: 'criteria-search-demo-r1',
          criteria: { keywords: ['synthetic candidate'], regions: ['region_demo_001'] }
        }
      : null,
  scheduleClock: () => new Date(clock),
  candidateSearchProvider: syntheticColdSearchProvider
});

const seeded = await server.coldSearchSchedules.handle(
  { action: 'enable', vacancyId, interval_hours: 0.5 }, context
);
if (seeded.kind !== 'updated') throw new Error(`sandbox_schedule_seed_failed:${seeded.kind}`);

// Seed one already-due occurrence at the current wall-clock time so the linked
// demo opens with fresh results without showing a future search timestamp.
const firstSchedule = server.coldSearchScheduleRepository.listSchedules(profileId)[0];
clock = new Date();
server.coldSearchScheduleRepository.upsertSchedule({
  ...firstSchedule,
  nextRunAt: clock.toISOString(),
  updatedAt: clock.toISOString()
});
const firstTick = await server.coldSearchSchedules.tick('public-sandbox-scheduler');
if (firstTick.claimed !== 1 || firstTick.completed !== 1 || firstTick.unknown !== 0) {
  throw new Error(`sandbox_first_cycle_failed:${JSON.stringify(firstTick)}`);
}
clock = new Date();

const timer = setInterval(async () => {
  if (tickInProgress) return;
  tickInProgress = true;
  clock = new Date();
  try {
    const result = await server.coldSearchSchedules.tick('public-sandbox-scheduler');
    if (result.claimed || result.unknown) {
      process.stdout.write(JSON.stringify({ event: 'sandbox_schedule_tick', ...result }) + '\n');
    }
  } catch {
    process.stderr.write('sandbox_schedule_tick_failed\n');
  } finally {
    tickInProgress = false;
  }
}, 15_000);
timer.unref();

const port = Number(process.env.RECRUITING_SANDBOX_PORT ?? 34427);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RECRUITING_SANDBOX_PORT must be 1..65535');
server.listen(port, '127.0.0.1', () => process.stdout.write(JSON.stringify({
  status: 'ready',
  host: '127.0.0.1',
  port,
  profileId,
  vacancyId,
  scheduleIntervalHours: 0.5,
  seededOccurrence: 'completed',
  provider: 'synthetic fixture'
}) + '\n'));

function stop() {
  clearInterval(timer);
  server.close(() => process.exit(0));
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
