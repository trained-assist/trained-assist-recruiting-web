import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { R03LegacyRehearsal } from '../src/r03-legacy-rehearsal.js';

const golden = JSON.parse(readFileSync(new URL('../data/r03-legacy-inventory-golden.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(golden);
const bind = ref => ({ legacy_synthetic_work: 'profile_synthetic_work',
  legacy_synthetic_test: 'profile_synthetic_test' })[ref] ?? null;
const owned = (profileId, vacancyId) => profileId === 'profile_synthetic_work' &&
  /^vac_synthetic_0(?:0[1-9]|10)$/.test(vacancyId) ||
  profileId === 'profile_synthetic_test' && vacancyId === 'vac_synthetic_011';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'r03-legacy-rehearsal-'));
  const filename = join(directory, 'private.sqlite');
  const opened = [];
  t.after(() => { for (const instance of opened) if (instance.db.open) instance.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = settings => { const instance = new R03LegacyRehearsal({ filename, hmacKey: Buffer.alloc(32, 42),
    bindProfile: bind, isVacancyOwned: owned, ...options, ...settings }); opened.push(instance); return instance; };
  return { filename, open };
}

test('invented golden plans 11 paused schedules, 8 unknown and wildcard quarantine without raw source fields', t => {
  const f = fixture(t);
  const importer = f.open();
  const planned = importer.plan(copy());
  assert.equal(planned.materialized, false);
  assert.equal(planned.totals.schedules, 11);
  assert.equal(planned.totals.allCandidates, 3);
  assert.deepEqual(planned.quarantine, { wildcardCandidates: 1, unknownSchedules: 8, generatedQueryCaches: 1 });
  assert.equal(planned.profiles[0].counts.schedules, 10);
  assert.equal(planned.profiles[1].counts.schedules, 1);
  assert.match(planned.manifestDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(planned), /resume_synthetic|legacy_synthetic|vac_synthetic|invented query/i);
  assert.equal(importer.db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_rehearsal').get().n, 0);
});

test('staging is atomic, idempotent and metadata-only across restart', t => {
  const f = fixture(t);
  const first = f.open();
  const staged = first.stage(copy());
  assert.equal(staged.kind, 'staged');
  assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_rehearsal_profile').get().n, 2);
  const payload = first.db.prepare('SELECT payload FROM r03_legacy_rehearsal').get().payload;
  assert.doesNotMatch(payload, /resume_synthetic|legacy_synthetic|vac_synthetic|Private note/i);
  first.close();
  const reopened = f.open();
  assert.equal(reopened.stage(copy()).kind, 'replayed');
  const changed = copy();
  changed.profiles[0].schedules[0].cron = '12 7 * * *';
  assert.equal(reopened.stage(changed).kind, 'migration_conflict');
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_rehearsal').get().n, 1);
});

test('count drift, unowned binding, wildcard raw payload and unknown replay activation fail closed', t => {
  const f = fixture(t);
  const importer = f.open();
  const cases = [
    fixture => { fixture.expectedCounts.schedules = 10; },
    fixture => { fixture.profiles[0].schedules[0].enabled = true; },
    fixture => { fixture.profiles[0].schedules[0].vacancyId = 'vac_other'; },
    fixture => { fixture.profiles[0].allCandidates[1].name = 'Private person'; },
    fixture => { fixture.profiles[0].comments[0].text = 'Private note'; },
    fixture => { fixture.profiles[1].sourceProfileRef = 'legacy_synthetic_work'; },
    fixture => { fixture.profiles[1].schedules[0].legacyJobId = 'legacy_synthetic_001'; },
    fixture => { fixture.profiles[0].schedules[1].vacancyId = 'vac_synthetic_001'; },
    fixture => { fixture.profiles[0].seenIds[1] = { ...fixture.profiles[0].seenIds[0] }; },
    fixture => { fixture.profiles[0].snapshots[0].candidateIds = ['missing']; }
  ];
  for (const change of cases) {
    const input = copy(); change(input);
    assert.throws(() => importer.stage(input));
  }
  assert.equal(importer.db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_rehearsal').get().n, 0);
});

test('profile-stage failure rolls back manifest and every profile count', t => {
  let stages = 0;
  const f = fixture(t, { onStage: stage => { if (stage === 'profile_metadata' && ++stages === 2) throw new Error('invented_staging_crash'); } });
  const importer = f.open();
  assert.throws(() => importer.stage(copy()), /invented_staging_crash/);
  assert.equal(importer.db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_rehearsal').get().n, 0);
  assert.equal(importer.db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_rehearsal_profile').get().n, 0);
});
