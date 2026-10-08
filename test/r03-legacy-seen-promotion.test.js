import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { R03LegacyContentImporter } from '../src/r03-legacy-content-import.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { planLegacySeenPromotion, promoteLegacySeen } from '../src/r03-legacy-seen-promotion.js';
import { runPrivateLegacySeenPromotion } from '../src/r03-private-legacy-seen-promotion.js';

const profile = 'inventedprofile';
const vacancy = 'inventedvacancy';
const other = 'inventedother';
const migrationId = 'inventedfinal';
const owned = (p, v) => p === profile && [vacancy, other].includes(v);
const historical = 'historical_unowned';
const counts = { allCandidates: 6, seenIds: 9, snapshots: 0, comments: 0,
  globalComments: 0, wildcardQuarantined: 1, quarantinedSnapshots: 0,
  unboundSeen: 1, mismatchedSeen: 2, unsafeSeenVacancyBuckets: 1,
  unsafeSeenRows: 1, unboundSnapshotMembers: 0, mismatchedSnapshotMembers: 0,
  snapshotFilenameMismatches: 0, unboundVacancySnapshots: 0,
  unboundComments: 0, mismatchedComments: 0, unboundReferences: 1 };

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'r03-seen-promotion-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'private.sqlite');
  const candidates = Object.fromEntries([
    ['EligibleA', [vacancy]], ['EligibleB', [vacancy]], ['WrongVacancy', [other]],
    ['Wildcard', []], ['bad_id', [vacancy]], ['InvalidDate', [vacancy]]
  ].map(([id, vacancyIds]) => [id, { id, vacancy_ids: vacancyIds }]));
  const seenIds = { [vacancy]: { EligibleA: '2026-10-01', EligibleB: '2026-10-02',
    WrongVacancy: '2026-10-02', Wildcard: '2026-10-02', Missing: '2026-10-02',
    bad_id: '2026-10-02', InvalidDate: '2026-10-02T01:00:00.000Z' },
  'нескопированная': { EligibleA: '2026-10-02' },
  [historical]: { EligibleA: '2026-10-02' } };
  const input = { migrationId, sourceProfileRef: 'inventedsource',
    allCandidates: candidates, seenIds, snapshots: [], comments: {}, globalComments: null,
    expectedCounts: counts, sourceFiles: {
      'all-candidates.json': Buffer.from(JSON.stringify(candidates)),
      'seen-ids.json': Buffer.from(JSON.stringify(seenIds)) } };
  const importer = new R03LegacyContentImporter({ filename,
    bindProfile: source => source === 'inventedsource' ? profile : null,
    isVacancyOwned: owned,
    isQuarantinedSourceVacancy: (p, v) => p === profile && v === historical });
  const { kind, ...stableReceipt } = importer.import(input);
  assert.equal(kind, 'imported');
  importer.close();
  const candidateState = new SqliteRealHhCandidateState({ filename, isVacancyOwned: owned });
  candidateState.importSeen({ profileId: profile, vacancyId: vacancy,
    ids: ['EligibleB'], importedAt: '2026-10-04T00:00:00.000Z' });
  candidateState.close();
  const sourceReceipt = { migrationId, backupKind: 'final_frozen', archiveBytes: 12345,
    archiveSha256: 'a'.repeat(64), receipts: [stableReceipt] };
  return { directory, filename, sourceReceipt };
}

function seen(filename) {
  const db = new Database(filename, { readonly: true });
  try { return db.prepare('SELECT resume_id,first_seen_at FROM real_hh_seen ORDER BY resume_id').all(); }
  finally { db.close(); }
}

test('plan quarantines every invented anomaly and preserves exact scoped dates', t => {
  const f = fixture(t);
  const plan = planLegacySeenPromotion({ ...f, isVacancyOwned: owned });
  assert.deepEqual(plan.counts, { sourceRows: 9, eligible: 2, unsafeVacancy: 1,
    unownedVacancy: 1, dangling: 1, wrongVacancy: 1, wildcard: 1,
    invalidResumeId: 1, invalidDate: 1 });
  assert.equal(seen(f.filename).length, 1, 'plan is read-only');
  assert.match(plan.selectionSha256, /^[a-f0-9]{64}$/);
  assert.match(plan.sourceReceiptSha256, /^[a-f0-9]{64}$/);
});

test('promotion is atomic, advances only older first-seen date and replays exactly', t => {
  const f = fixture(t);
  const plan = planLegacySeenPromotion({ ...f, isVacancyOwned: owned });
  const command = { ...f, isVacancyOwned: owned, expectedCounts: plan.counts,
    expectedSelectionSha256: plan.selectionSha256 };
  assert.throws(() => promoteLegacySeen({ ...command, onStep: stage => {
    if (stage === 'seen') throw new Error('invented_transaction_failure');
  } }), /invented_transaction_failure/);
  assert.deepEqual(seen(f.filename), [{ resume_id: 'EligibleB', first_seen_at: '2026-10-04T00:00:00.000Z' }]);
  const first = promoteLegacySeen(command);
  assert.equal(first.kind, 'promoted');
  assert.equal(first.inserted, 1);
  assert.equal(first.advanced, 1);
  assert.deepEqual(seen(f.filename), [
    { resume_id: 'EligibleA', first_seen_at: '2026-10-01' },
    { resume_id: 'EligibleB', first_seen_at: '2026-10-02' }]);
  const replay = promoteLegacySeen(command);
  assert.equal(replay.kind, 'replayed');
  assert.equal(replay.inserted, 1);
  const db = new Database(f.filename, { readonly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM r03_legacy_seen_promotion').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM real_hh_snapshot').get().n, 0);
  } finally { db.close(); }
});

test('wrong source receipt, ownership and changed plan fail before seen mutation', t => {
  const f = fixture(t);
  const plan = planLegacySeenPromotion({ ...f, isVacancyOwned: owned });
  const command = { ...f, isVacancyOwned: owned, expectedCounts: plan.counts,
    expectedSelectionSha256: plan.selectionSha256 };
  assert.throws(() => promoteLegacySeen({ ...command, expectedSelectionSha256: 'b'.repeat(64) }),
    /legacy_seen_promotion_unavailable/);
  assert.throws(() => planLegacySeenPromotion({ ...f, isVacancyOwned: () => false }),
    /legacy_seen_promotion_unavailable/);
  assert.throws(() => planLegacySeenPromotion({ ...f,
    sourceReceipt: { ...f.sourceReceipt, backupKind: 'initial_unfrozen' }, isVacancyOwned: owned }),
  /legacy_seen_promotion_unavailable/);
  const changed = structuredClone(f.sourceReceipt);
  changed.receipts[0].sourceDigest = 'b'.repeat(64);
  assert.throws(() => promoteLegacySeen({ ...command, sourceReceipt: changed }),
    /legacy_seen_promotion_unavailable/);
  assert.equal(seen(f.filename).length, 1);
});

test('private CLI writes owner-only dry plan and an idempotent promotion receipt', t => {
  const f = fixture(t);
  const receipts = join(f.directory, 'receipts');
  mkdirSync(receipts, { mode: 0o700 });
  writeFileSync(join(receipts, `${migrationId}.json`), JSON.stringify(f.sourceReceipt), { mode: 0o600 });
  const configFile = join(f.directory, 'import-config.json');
  writeFileSync(configFile, JSON.stringify({ version: 'r03-private-legacy-import-v1',
    migrationId, targetDbPath: f.filename, receiptDirectory: receipts,
    archiveSha256: f.sourceReceipt.archiveSha256, archiveBytes: f.sourceReceipt.archiveBytes,
    profiles: [{ profileId: profile, vacancyIds: [vacancy, other],
      quarantinedSourceVacancyIds: [historical] }] }), { mode: 0o600 });
  const planFile = join(receipts, 'seen-plan.json');
  const command = { configFile, planFile };
  const planned = runPrivateLegacySeenPromotion({ ...command, mode: 'plan' });
  assert.equal(planned.counts.eligible, 2);
  assert.equal(planned.counts.unownedVacancy, 1);
  assert.equal(statSync(planFile).mode & 0o077, 0);
  assert.equal(seen(f.filename).length, 1);
  assert.throws(() => runPrivateLegacySeenPromotion({ ...command, mode: 'promote' }),
    /private_legacy_seen_promotion_unavailable/);
  const promoted = runPrivateLegacySeenPromotion({ ...command, mode: 'promote', execute: true });
  assert.equal(promoted.inserted, 1);
  assert.equal(promoted.advanced, 1);
  const receiptPath = join(receipts, `${migrationId}-seen-promotion.json`);
  assert.equal(statSync(receiptPath).mode & 0o077, 0);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.counts.unownedVacancy, 1);
  assert.equal(runPrivateLegacySeenPromotion({ ...command, mode: 'promote', execute: true }).kind,
    'replayed');
  assert.equal(seen(f.filename).length, 2);
});
