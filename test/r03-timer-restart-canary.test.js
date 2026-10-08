import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intervalPlan, nextOccurrenceAfter } from '../src/cold-search-schedules.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { createOfflineHhColdSearch } from '../src/hh-cold-search-offline.js';
import { createDurableHhOccurrenceWorker } from '../src/r03-durable-hh-worker.js';
import { runPrivateHhMinuteTick } from '../src/r03-private-minute-tick.js';

const profileId = 'profile_timer_fixture';
const vacancyId = 'vacancy_timer_fixture';
const searchPlan = { profileId, vacancyId, criteriaRevision: 'criteria_timer_r1',
  queryCache: { revision: 'queries_timer_r1', queries: ['invented engineer'] },
  atsConfig: { filters: { min_experience_years: 0 },
    required: [{ name: 'engineer', weight: 2 }] }, area: null };

test('minute unit supplies every credential consumed by the real host CLI', () => {
  const unit = readFileSync(new URL('../infra/systemd/trained-recruiting-hh-minute.service', import.meta.url), 'utf8');
  for (const name of ['hh_encryption_key', 'hh_client_id', 'hh_client_secret', 'hh_user_agent', 'ladder_token'])
    assert.match(unit, new RegExp(`^LoadCredential=${name}:`, 'm'));
  assert.match(unit, /--mode minute .*--live-execution/);
  assert.match(readFileSync(new URL('../infra/systemd/trained-recruiting-hh-minute.timer', import.meta.url), 'utf8'),
    /Persistent=false/);
});

test('real SQLite minute entrypoint completes two due slots across process restart without touching quarantined jobs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'r03-timer-restart-'));
  const filename = join(directory, 'state.sqlite');
  const stores = [];
  t.after(() => { for (const store of stores) if (store.db.open) store.close();
    rmSync(directory, { recursive: true, force: true }); });
  const open = () => {
    const schedules = new SqliteColdSearchScheduleRepository(filename);
    const candidates = new SqliteRealHhCandidateState({ filename,
      isVacancyOwned: (p, v) => p === profileId && v === vacancyId });
    stores.push(schedules, candidates);
    return { schedules, candidates };
  };
  let now = '2026-10-06T00:00:00.000Z';
  let providerCalls = 0;
  const first = open();
  const plan = intervalPlan(24, vacancyId);
  const due = nextOccurrenceAfter(plan, now);
  for (let index = 0; index < 11; index++) first.schedules.upsertSchedule({
    scheduleId: `imported_${index}`, legacyJobId: `legacy_${index}`,
    profileId, vacancyId, enabled: false, plan, timezone: 'Europe/Moscow',
    nextRunAt: due, leaseOwner: null, leaseUntil: null,
    blockedByUnknownOccurrenceId: index < 8 ? `unknown_${index}` : `import_hold_${index}`,
    migrationQuarantine: { reason: 'unreviewed' } });
  first.schedules.upsertSchedule({ scheduleId: 'isolated_canary', legacyJobId: 'isolated_canary',
    profileId, vacancyId, enabled: true, plan, timezone: 'Europe/Moscow',
    nextRunAt: due, leaseOwner: null, leaseUntil: null, blockedByUnknownOccurrenceId: null });
  const tick = async ({ schedules, candidates }, workerId) => {
    const transport = { search: async () => {
      providerCalls++;
      return { profileId, vacancyId, areas: [], items: [{ id: 'inventedresume001',
        title: 'Invented engineer', first_name: 'Invented', last_name: 'Person',
        area: { name: 'Invented region' }, total_experience: { months: 36 },
        experience: [{ position: 'engineer', company: 'Invented company' }] }] };
    } };
    const loadSearchPlan = async () => searchPlan;
    const search = createOfflineHhColdSearch({ loadSearchPlan, transport, candidateState: candidates,
      clock: () => new Date(now) });
    const worker = createDurableHhOccurrenceWorker({ scheduleRepository: schedules, loadSearchPlan,
      search, candidateState: candidates, clock: () => new Date(now) });
    return runPrivateHhMinuteTick({ worker, scheduleRepository: schedules, workerId,
      clock: () => new Date(now) });
  };
  now = due;
  const firstTick = await tick(first, 'first_process');
  assert.equal(firstTick.result.completed, 1, JSON.stringify({ firstTick,
    occurrence: first.schedules.listOccurrences(profileId) }));
  assert.equal(providerCalls, 1);
  first.schedules.close();
  first.candidates.close();
  const restarted = open();
  assert.equal((await tick(restarted, 'restarted_process')).result.claimed, 0);
  assert.equal(providerCalls, 1);
  const secondDue = restarted.schedules.getSchedule('isolated_canary').nextRunAt;
  now = secondDue;
  assert.equal((await tick(restarted, 'restarted_process')).result.completed, 1);
  assert.equal(providerCalls, 2);
  assert.equal(restarted.schedules.listOccurrences(profileId).length, 2);
  assert.equal(restarted.schedules.listAllSchedules().filter(row => row.enabled).length, 1);
  assert.equal(restarted.schedules.listAllSchedules().filter(row => row.migrationQuarantine).length, 11);
  assert.equal(restarted.candidates.seenTotal(profileId, vacancyId), 1);
  assert.equal(restarted.schedules.db.pragma('integrity_check', { simple: true }), 'ok');
});
