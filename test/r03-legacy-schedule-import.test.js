import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createColdSearchScheduleHandler } from '../src/cold-search-schedules.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { R03LegacyScheduleImport, legacyCronToPlan } from '../src/r03-legacy-schedule-import.js';

const inventory = JSON.parse(readFileSync(new URL('../data/r03-legacy-inventory-golden.json', import.meta.url), 'utf8'));
const profileMap = { legacy_synthetic_work: 'profile_synthetic_work', legacy_synthetic_test: 'profile_synthetic_test' };
const bind = ref => profileMap[ref] ?? null;
const owned = (profile, vacancy) => profile === 'profile_synthetic_work' && /^vac_synthetic_0(?:0[1-9]|10)$/.test(vacancy) ||
  profile === 'profile_synthetic_test' && vacancy === 'vac_synthetic_011';
const definitions = inventory.profiles.flatMap(profile => profile.schedules.map(schedule => ({
  ...schedule, sourceProfileRef: profile.sourceProfileRef, name: `cold-search:${schedule.vacancyId}`,
  action: 'hh_proactive_search', arguments: { vacancy_id: schedule.vacancyId }
})));
const envelope = () => ({ version: 'legacy-hh-schedules-v1', migrationId: 'migration_synthetic_001', definitions: structuredClone(definitions) });

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-schedule-import-'));
  const filename = join(directory, 'private.sqlite');
  const opened = [];
  t.after(() => { for (const instance of opened) if (instance.db.open) instance.close(); rmSync(directory, { recursive: true, force: true }); });
  const repo = new SqliteColdSearchScheduleRepository(filename);
  opened.push(repo);
  const adapter = new R03LegacyScheduleImport({ repository: repo, bindProfile: bind, isVacancyOwned: owned,
    clock: () => new Date('2026-10-06T06:00:00.000Z'), ...options });
  return { repo, adapter };
}

test('parser preserves each legacy intervalToCron form and rejects unsupported cron', () => {
  assert.deepEqual(legacyCronToPlan('7,37 * * * *'), { requestedIntervalHours: 0.5, intervalHours: 0.5, mode: 'half_hour', minute: 7 });
  assert.deepEqual(legacyCronToPlan('12 * * * *'), { requestedIntervalHours: 1, intervalHours: 1, mode: 'hour_step', minute: 12, hourPhase: 0 });
  assert.deepEqual(legacyCronToPlan('15 2-23/3 * * *'), { requestedIntervalHours: 3, intervalHours: 3, mode: 'hour_step', minute: 15, hourPhase: 2 });
  assert.deepEqual(legacyCronToPlan('9 18 * * *'), { requestedIntervalHours: 24, intervalHours: 24, mode: 'day_step', days: 1, minute: 9, hour: 18 });
  assert.deepEqual(legacyCronToPlan('9 18 */2 * *'), { requestedIntervalHours: 48, intervalHours: 48, mode: 'day_step', days: 2, minute: 9, hour: 18 });
  for (const unsupported of ['*/5 * * * *', '7 6 * * *', '7 19 * * *', '7 18 1 * *', '7 18 */32 * *', '07 18 * * *', '7 3-23/3 * * *', '7,38 * * * *'])
    assert.throws(() => legacyCronToPlan(unsupported), /unsupported_legacy_cron/);
});

test('11 definitions import atomically disabled, exact cron retained, 8 unknown quarantined and no tick replay', async t => {
  const f = fixture(t);
  const result = f.adapter.import(envelope());
  assert.deepEqual(result, { imported: 11, replayed: 0, quarantined: 11, unknown: 8 });
  const all = f.repo.listAllSchedules();
  assert.equal(all.length, 11);
  assert.equal(all.filter(row => row.profileId === 'profile_synthetic_work').length, 10);
  assert.equal(all.filter(row => row.profileId === 'profile_synthetic_test').length, 1);
  assert.equal(all.filter(row => row.migrationQuarantine.reason === 'legacy_outcome_unknown').length, 8);
  for (const definition of definitions) {
    const selected = all.find(row => row.legacyJobId === definition.legacyJobId);
    assert.equal(selected.legacyCron, definition.cron);
    assert.equal(selected.enabled, false);
    assert.equal(selected.timezone, 'Europe/Moscow');
    assert.match(selected.blockedByUnknownOccurrenceId, /^migration_pending_/);
  }
  const handler = createColdSearchScheduleHandler({ repository: f.repo,
    resolveSearchRequest: async () => null, executeSearch: async () => { throw new Error('must_not_dispatch'); },
    clock: () => new Date('2026-10-07T12:00:00.000Z') });
  assert.deepEqual(await handler.tick('worker_synthetic_001'), { claimed: 0, completed: 0, unknown: 0 });
  assert.equal((await handler.handle({ action: 'enable', vacancyId: 'vac_synthetic_001', interval_hours: 24 },
    { profileId: 'profile_synthetic_work', scopes: ['recruiting.candidateSearch'] })).kind, 'invalid_vacancy',
  'the current synthetic command boundary cannot activate an imported vacancy');
  assert.deepEqual(f.adapter.import(envelope()), { imported: 0, replayed: 11, quarantined: 0, unknown: 0 });
  assert.equal(f.repo.listAllSchedules().length, 11);
});

test('source mismatch and unsupported cron fail before write; changed legacy ID conflicts without overwrite', t => {
  const f = fixture(t);
  const invalid = envelope();
  invalid.definitions[10].cron = '*/5 * * * *';
  assert.throws(() => f.adapter.import(invalid), /unsupported_legacy_cron/);
  assert.equal(f.repo.listAllSchedules().length, 0);
  const enabled = envelope(); enabled.definitions[0].enabled = true;
  assert.throws(() => f.adapter.import(enabled), /invalid_legacy_schedule_definition/);
  const wrong = envelope(); wrong.definitions[0].sourceProfileRef = 'legacy_synthetic_test';
  assert.throws(() => f.adapter.import(wrong), /legacy_schedule_binding_denied/);
  f.adapter.import(envelope());
  const changed = envelope(); changed.definitions[0].cron = '12 7 * * *';
  assert.throws(() => f.adapter.import(changed), /legacy_schedule_import_conflict/);
  assert.equal(f.repo.listAllSchedules().find(row => row.legacyJobId === definitions[0].legacyJobId).legacyCron, definitions[0].cron);
});

test('mid-batch write failure rolls back all 11 rows and import receipts', t => {
  let count = 0;
  const f = fixture(t, { onStage: () => { if (++count === 5) throw new Error('invented_import_crash'); } });
  assert.throws(() => f.adapter.import(envelope()), /invented_import_crash/);
  assert.equal(f.repo.listAllSchedules().length, 0);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_schedule_import').get().n, 0);
});
