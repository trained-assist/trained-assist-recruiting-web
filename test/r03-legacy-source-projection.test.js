import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { R03LegacyRehearsal } from '../src/r03-legacy-rehearsal.js';
import { projectLegacyR03Sources, legacyR03ExpectedCounts } from '../src/r03-legacy-source-projection.js';

const source = () => ({
  sourceProfileRef: 'invented_source',
  allCandidates: {
    inventedresume01: { id: 'inventedresume01', first_name: 'SECRET_SYNTHETIC_NAME', vacancy_ids: ['vacancy01'] },
    inventedresume02: { id: 'inventedresume02', first_name: 'OTHER_SYNTHETIC_NAME' },
  },
  seenIds: { vacancy01: { inventedresume01: '2026-09-28' } },
  snapshots: [{ filename: 'search-results-2026-09-28-vacancy01.json', value: {
    vacancy_id: 'vacancy01', searched_at: '2026-09-28T08:00:00.000Z',
    candidates: [{ id: 'inventedresume01', first_name: 'SECRET_SYNTHETIC_NAME' }],
  } }],
  queryCaches: [{ vacancyId: 'vacancy01', value: {
    vacancy_id: 'vacancy01', queries: ['SECRET_SYNTHETIC_QUERY'], manual: true,
  } }],
  comments: [{ vacancyId: 'vacancy01', value: {
    inventedresume01: { text: 'SECRET_SYNTHETIC_COMMENT' },
  } }],
  atsConfigs: [{ vacancyId: 'vacancy01', value: { value: { vacancy_title: 'SECRET_SYNTHETIC_ATS' } } }],
  schedules: [{ legacyJobId: 'job01', vacancyId: 'vacancy01', cron: '3 */12 * * *',
    timezone: 'Europe/Moscow', enabled: false, lastStatus: 'unknown' }],
});

test('source-shaped files project into private rehearsal without names, query, comment or ATS text', t => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-r03-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const projected = projectLegacyR03Sources(source());
  const counts = legacyR03ExpectedCounts([projected]);
  assert.deepEqual(counts, { allCandidates: 2, seenIds: 1, snapshots: 1,
    queryCaches: 1, comments: 1, atsConfigs: 1, schedules: 1 });
  const serialized = JSON.stringify(projected);
  for (const secret of ['SECRET_SYNTHETIC_NAME', 'SECRET_SYNTHETIC_QUERY',
    'SECRET_SYNTHETIC_COMMENT', 'SECRET_SYNTHETIC_ATS']) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(projected.allCandidates[1].vacancyIds, [], 'legacy wildcard remains explicit');
  const rehearsal = new R03LegacyRehearsal({ filename: join(dir, 'inventory.sqlite'),
    hmacKey: Buffer.alloc(32, 4), bindProfile: () => 'profile01',
    isVacancyOwned: (profileId, vacancyId) => profileId === 'profile01' && vacancyId === 'vacancy01' });
  t.after(() => rehearsal.close());
  const envelope = { migrationId: 'invented_migration_01', profiles: [projected],
    expectedScheduleCount: 1, expectedCounts: counts };
  const staged = rehearsal.stage(envelope);
  assert.equal(staged.kind, 'staged');
  assert.deepEqual(staged.plan.quarantine, { wildcardCandidates: 1,
    unknownSchedules: 1, generatedQueryCaches: 0 });
  assert.equal(rehearsal.stage(envelope).kind, 'replayed');
});

test('wrong snapshot vacancy and dangling seen candidate fail before staging', () => {
  const badSnapshot = source();
  badSnapshot.snapshots[0].value.vacancy_id = 'vacancy02';
  assert.throws(() => projectLegacyR03Sources(badSnapshot), /legacy_snapshot_vacancy_mismatch/);
  const dangling = source();
  dangling.seenIds.vacancy01.inventedresume99 = '2026-09-28';
  const projected = projectLegacyR03Sources(dangling);
  const dir = mkdtempSync(join(tmpdir(), 'legacy-r03-dangling-'));
  try {
    const rehearsal = new R03LegacyRehearsal({ filename: join(dir, 'inventory.sqlite'),
      hmacKey: Buffer.alloc(32, 4), bindProfile: () => 'profile01', isVacancyOwned: () => true });
    try {
      assert.throws(() => rehearsal.plan({ migrationId: 'invented_migration_02', profiles: [projected],
        expectedScheduleCount: 1, expectedCounts: legacyR03ExpectedCounts([projected]) }),
      /invalid_legacy_seen_inventory/);
    } finally { rehearsal.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing IDs and unscoped ATS or query source fail before a projection is returned', () => {
  const missingCandidateId = source();
  delete missingCandidateId.allCandidates.inventedresume01.id;
  assert.throws(() => projectLegacyR03Sources(missingCandidateId), /invalid_legacy_candidate_source/);
  const missingSnapshotId = source();
  delete missingSnapshotId.snapshots[0].value.candidates[0].id;
  assert.throws(() => projectLegacyR03Sources(missingSnapshotId), /invalid_legacy_snapshot_candidate/);
  const unscopedAts = source();
  unscopedAts.atsConfigs[0].vacancyId = undefined;
  assert.throws(() => projectLegacyR03Sources(unscopedAts), /invalid_legacy_ats_source/);
  const crossVacancyQuery = source();
  crossVacancyQuery.queryCaches[0].value.vacancy_id = 'vacancy02';
  assert.throws(() => projectLegacyR03Sources(crossVacancyQuery), /invalid_legacy_query_source/);
  const stringAts = source();
  stringAts.atsConfigs[0].value.value = JSON.stringify({ vacancy_id: 'vacancy01',
    vacancy_title: 'SECRET_SYNTHETIC_ATS' });
  assert.equal(projectLegacyR03Sources(stringAts).atsConfigs[0].vacancyId, 'vacancy01');
  stringAts.atsConfigs[0].value.value = JSON.stringify({ vacancy_id: 'vacancy02' });
  assert.throws(() => projectLegacyR03Sources(stringAts), /invalid_legacy_ats_source/);
});
