import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runPrivateLegacyImport } from '../src/r03-private-legacy-import-runner.js';
import { createPrivateLegacyInventory } from '../src/r03-private-legacy-inventory.js';
import { createPrivateLegacyBinding } from '../src/r03-private-legacy-binding.js';

const sourceRef = 'invented_legacy_user';
const profileId = 'invented_profile';
const vacancyId = 'invented_vacancy';
const resumeId = 'invented_resume';
const migrationId = 'invented_initial_backup';
const counts = { allCandidates: 1, seenIds: 1, snapshots: 1, comments: 1, globalComments: 0,
  wildcardQuarantined: 0, quarantinedSnapshots: 1, unboundSeen: 0, mismatchedSeen: 0,
  unsafeSeenVacancyBuckets: 0, unsafeSeenRows: 0, unboundSnapshotMembers: 0,
  mismatchedSnapshotMembers: 0, snapshotFilenameMismatches: 0, unboundVacancySnapshots: 0,
  unboundComments: 0, mismatchedComments: 0, unboundReferences: 0 };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-private-import-runner-')));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const proactive = join(source, 'agent-data', 'hh', sourceRef, 'proactive');
  const tokenDir = join(source, 'agent-tokens');
  const contextDir = join(source, 'users', sourceRef, 'contexts');
  const backup = join(root, 'backup');
  const dbDir = join(root, 'db');
  const scratch = join(root, 'scratch');
  const receipts = join(root, 'receipts');
  for (const path of [proactive, tokenDir, contextDir, backup, dbDir, scratch, receipts])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const file = (name, value) => writeFileSync(join(proactive, name), JSON.stringify(value), { mode: 0o600 });
  file('all-candidates.json', { [resumeId]: { id: resumeId, vacancy_ids: [vacancyId],
    first_name: 'Вымышленная', source: 'search' } });
  file('seen-ids.json', { [vacancyId]: { [resumeId]: '2026-10-01' } });
  file(`search-results-2026-10-02-${vacancyId}.json`, { vacancy_id: vacancyId,
    searched_at: '2026-10-02T06:00:00.000Z', candidates: [{ id: resumeId, score: 5 }] });
  file(`candidate-comments-${vacancyId}.json`, { [resumeId]: { text: 'Вымышленная заметка' } });
  writeFileSync(join(tokenDir, 'placeholder.txt'), 'invented', { mode: 0o600 });
  writeFileSync(join(contextDir, 'placeholder.txt'), 'invented', { mode: 0o600 });
  const archivePath = join(backup, 'initial.tar');
  const tar = spawnSync('tar', ['-cf', archivePath, '-C', source,
    'agent-data/hh', 'agent-tokens', 'users'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  chmodSync(archivePath, 0o400);
  const bytes = readFileSync(archivePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifestPath = join(backup, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ migrationId, kind: 'initial_unfrozen',
    bytes: bytes.length, sha256 }), { mode: 0o400 });
  const configFile = join(root, 'config.json');
  const config = { version: 'r03-private-legacy-import-v1', migrationId,
    archivePath, archiveBytes: bytes.length, archiveSha256: sha256, manifestPath,
    targetDbPath: join(dbDir, 'candidate.sqlite'), scratchDirectory: scratch,
    receiptDirectory: receipts, profiles: [{ sourceProfileRef: sourceRef, profileId,
      vacancyIds: [vacancyId], quarantinedSourceVacancyIds: [], expectedCounts: counts }] };
  const saveConfig = value => writeFileSync(configFile, JSON.stringify(value), { mode: 0o600 });
  saveConfig(config);
  return { root, source, proactive, archivePath, manifestPath, configFile, config, saveConfig, receipts };
}

function resign(f) {
  chmodSync(f.archivePath, 0o400);
  const bytes = readFileSync(f.archivePath);
  f.config.archiveBytes = bytes.length;
  f.config.archiveSha256 = createHash('sha256').update(bytes).digest('hex');
  chmodSync(f.manifestPath, 0o600);
  writeFileSync(f.manifestPath, JSON.stringify({ migrationId, kind: 'initial_unfrozen',
    bytes: bytes.length, sha256: f.config.archiveSha256 }));
  chmodSync(f.manifestPath, 0o400);
  f.saveConfig(f.config);
}

test('dry-run checks an invented private archive without creating the target DB', async t => {
  const f = fixture(t);
  const result = await runPrivateLegacyImport({ mode: 'check', configFile: f.configFile });
  assert.equal(result.status, 'ready');
  assert.equal(result.backupKind, 'initial_unfrozen');
  assert.equal(result.profileCount, 1);
  assert.deepEqual(result.counts, counts);
  assert.throws(() => statSync(f.config.targetDbPath), /ENOENT/);
  assert.equal(statSync(f.config.scratchDirectory).mode & 0o077, 0);
});

test('private inventory derives counts and leaves target identity unresolved', async t => {
  const f = fixture(t);
  const inventoryFile = join(f.receipts, 'inventory.json');
  const command = { archivePath: f.archivePath, manifestPath: f.manifestPath,
    scratchDirectory: f.config.scratchDirectory, inventoryFile };
  const first = await createPrivateLegacyInventory(command);
  assert.equal(first.status, 'inventoried');
  assert.deepEqual(first.totals, counts);
  assert.equal(statSync(inventoryFile).mode & 0o077, 0);
  const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
  assert.equal(inventory.profiles[0].sourceProfileRef, sourceRef);
  assert.equal(inventory.profiles[0].targetProfileId, null);
  assert.deepEqual(inventory.profiles[0].observedVacancyIds, [vacancyId]);
  assert.deepEqual(inventory.profiles[0].expectedCounts, counts);
  assert.deepEqual(await createPrivateLegacyInventory(command), first);
  assert.throws(() => statSync(f.config.targetDbPath), /ENOENT/);
});

test('agent-owned cron and context authority bind exact source scope with one reviewed exclusion', async t => {
  const f = fixture(t);
  const historical = 'invented_historical';
  writeFileSync(join(f.proactive, 'seen-ids.json'), JSON.stringify({
    [vacancyId]: { [resumeId]: '2026-10-01' },
    [historical]: { [resumeId]: '2026-10-02' } }));
  const context = join(f.source, 'users', sourceRef, 'contexts', 'hh');
  mkdirSync(context, { recursive: true, mode: 0o700 });
  writeFileSync(join(context, 'active_vacancies.json'), JSON.stringify({
    value: [{ id: vacancyId }] }));
  chmodSync(f.archivePath, 0o600);
  const tar = spawnSync('tar', ['-cf', f.archivePath, '-C', f.source,
    'agent-data/hh', 'agent-tokens', 'users'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  resign(f);
  chmodSync(f.manifestPath, 0o600);
  writeFileSync(f.manifestPath, JSON.stringify({ migrationId, kind: 'final_frozen',
    bytes: f.config.archiveBytes, sha256: f.config.archiveSha256 }));
  chmodSync(f.manifestPath, 0o400);
  const inventoryFile = join(f.receipts, 'binding-inventory.json');
  await createPrivateLegacyInventory({ archivePath: f.archivePath, manifestPath: f.manifestPath,
    scratchDirectory: f.config.scratchDirectory, inventoryFile });
  const cronDirectory = join(f.root, 'cron');
  mkdirSync(cronDirectory, { mode: 0o700 });
  const cronDbPath = join(cronDirectory, 'core.sqlite');
  const cron = new Database(cronDbPath);
  cron.exec('CREATE TABLE cron_jobs (profile_id TEXT, arguments_json TEXT, enabled INTEGER, last_status TEXT, action TEXT)');
  const add = cron.prepare('INSERT INTO cron_jobs VALUES(?,?,?,?,?)');
  for (let i = 0; i < 11; i++)
    add.run(sourceRef, JSON.stringify({ vacancy_id: vacancyId }), 0,
      i < 8 ? 'unknown' : 'failed', 'hh_proactive_search');
  cron.close();
  chmodSync(cronDbPath, 0o400);
  const cronBytes = readFileSync(cronDbPath);
  const cronManifestPath = join(cronDirectory, 'manifest.json');
  writeFileSync(cronManifestPath, JSON.stringify({ kind: 'cron_frozen', bytes: cronBytes.length,
    sha256: createHash('sha256').update(cronBytes).digest('hex'), hhCronDefinitions: 11,
    enabled: 0, unknown: 8 }), { mode: 0o400 });
  const outputFile = join(f.receipts, 'binding.json');
  const args = { archivePath: f.archivePath, manifestPath: f.manifestPath,
    inventoryFile, cronDbPath, cronManifestPath, targetDbPath: f.config.targetDbPath,
    scratchDirectory: f.config.scratchDirectory, receiptDirectory: f.receipts,
    outputFile, expectedExcludedVacancies: 1 };
  await assert.rejects(createPrivateLegacyBinding({ ...args, expectedExcludedVacancies: 0 }),
    /private_legacy_binding_unavailable/);
  const result = await createPrivateLegacyBinding(args);
  assert.equal(result.quarantinedSourceVacancyScopes, 1);
  assert.equal(statSync(outputFile).mode & 0o077, 0);
  const config = JSON.parse(readFileSync(outputFile, 'utf8'));
  assert.deepEqual(config.profiles[0].vacancyIds, [vacancyId]);
  assert.deepEqual(config.profiles[0].quarantinedSourceVacancyIds, [historical]);
  const checked = await runPrivateLegacyImport({ mode: 'check', configFile: outputFile });
  assert.equal(checked.quarantine.unownedSeenRows, 1);
  assert.throws(() => statSync(f.config.targetDbPath), /ENOENT/);
});

test('reviewed historical-only vacancy requires exact exclusion and receives a raw receipt', async t => {
  const f = fixture(t);
  const historical = 'invented_historical';
  writeFileSync(join(f.proactive, 'seen-ids.json'), JSON.stringify({
    [vacancyId]: { [resumeId]: '2026-10-01' },
    [historical]: { [resumeId]: '2026-10-02' } }));
  writeFileSync(join(f.proactive, `search-results-2026-10-04-${historical}.json`), JSON.stringify({
    vacancy_id: historical, searched_at: '2026-10-04T06:00:00.000Z',
    candidates: [{ id: resumeId }] }));
  chmodSync(f.archivePath, 0o600);
  const tar = spawnSync('tar', ['-cf', f.archivePath, '-C', f.source,
    'agent-data/hh', 'agent-tokens', 'users'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  resign(f);
  const expected = { ...counts, seenIds: 2, snapshots: 2, quarantinedSnapshots: 2,
    mismatchedSeen: 1, mismatchedSnapshotMembers: 1 };
  f.config.profiles[0].expectedCounts = expected;
  f.saveConfig(f.config);
  await assert.rejects(runPrivateLegacyImport({ mode: 'check', configFile: f.configFile }),
    /invalid_legacy_content_seen/);
  f.config.profiles[0].quarantinedSourceVacancyIds = [historical];
  f.saveConfig(f.config);
  const checked = await runPrivateLegacyImport({ mode: 'check', configFile: f.configFile });
  assert.deepEqual(checked.quarantine, { unownedVacancyScopes: 1, unownedSeenRows: 1,
    unownedSnapshots: 1 });
  assert.throws(() => statSync(f.config.targetDbPath), /ENOENT/);
  const imported = await runPrivateLegacyImport({ mode: 'import', configFile: f.configFile, execute: true });
  assert.equal(imported.importedProfiles, 1);
  const receipt = JSON.parse(readFileSync(join(f.receipts, `${migrationId}.json`), 'utf8'));
  assert.deepEqual(receipt.receipts[0].quarantine, { unownedVacancyIds: [historical],
    unownedSeenRows: 1, unownedSnapshots: 1 });
  const db = new Database(f.config.targetDbPath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM r03_legacy_content_seen WHERE unowned_vacancy=1').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name=?').get('real_hh_seen').count, 0);
});

test('private inventory CLI runs from a release without SQLite or node_modules', t => {
  const f = fixture(t);
  const isolated = join(f.root, 'isolated');
  mkdirSync(isolated, { mode: 0o700 });
  writeFileSync(join(isolated, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  for (const name of ['r03-private-legacy-archive.js', 'r03-private-legacy-inventory.js'])
    copyFileSync(new URL(`../src/${name}`, import.meta.url), join(isolated, name));
  const inventoryFile = join(f.receipts, 'isolated-inventory.json');
  const run = spawnSync(process.execPath, [join(isolated, 'r03-private-legacy-inventory.js'),
    '--archive', f.archivePath, '--manifest', f.manifestPath,
    '--scratch', f.config.scratchDirectory, '--inventory-file', inventoryFile],
  { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).profileCount, 1);
  assert.equal(statSync(inventoryFile).mode & 0o077, 0);
});

test('explicit import writes quarantined content, private receipt and idempotent replay', async t => {
  const f = fixture(t);
  await assert.rejects(runPrivateLegacyImport({ mode: 'import', configFile: f.configFile }),
    /private_legacy_import_unavailable/);
  const first = await runPrivateLegacyImport({ mode: 'import', configFile: f.configFile, execute: true });
  assert.equal(first.status, 'completed');
  assert.equal(first.importedProfiles, 1);
  const db = new Database(f.config.targetDbPath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM r03_legacy_content_candidate').get().count, 1);
  assert.equal(db.prepare('SELECT acceptance_status FROM r03_legacy_content_snapshot').get().acceptance_status, 'quarantined');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name=?').get('real_hh_seen').count, 0);
  const receiptPath = join(f.receipts, `${migrationId}.json`);
  assert.equal(statSync(receiptPath).mode & 0o077, 0);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.receipts[0].sourceReceipts.length, 4);
  const second = await runPrivateLegacyImport({ mode: 'import', configFile: f.configFile, execute: true });
  assert.equal(second.importedProfiles, 0);
});

test('wrong profile binding, receipt and archive bytes fail before target write', async t => {
  const f = fixture(t);
  const wrong = structuredClone(f.config);
  wrong.profiles[0].vacancyIds = ['another_invented_vacancy'];
  f.saveConfig(wrong);
  await assert.rejects(runPrivateLegacyImport({ mode: 'check', configFile: f.configFile }));
  assert.throws(() => statSync(f.config.targetDbPath), /ENOENT/);
  f.saveConfig(f.config);
  chmodSync(f.archivePath, 0o600);
  writeFileSync(f.archivePath, 'changed bytes', { flag: 'a' });
  chmodSync(f.archivePath, 0o400);
  await assert.rejects(runPrivateLegacyImport({ mode: 'import', configFile: f.configFile, execute: true }),
    /private_legacy_import_unavailable/);
  assert.throws(() => statSync(f.config.targetDbPath), /ENOENT/);
});

test('replay repairs receipt-file failure after the durable DB commit', async t => {
  const f = fixture(t);
  chmodSync(f.receipts, 0o500);
  await assert.rejects(runPrivateLegacyImport({ mode: 'import', configFile: f.configFile, execute: true }),
    /private_legacy_import_unavailable/);
  const db = new Database(f.config.targetDbPath, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM r03_legacy_content_candidate').get().count, 1);
  chmodSync(f.receipts, 0o700);
  const recovered = await runPrivateLegacyImport({ mode: 'import', configFile: f.configFile, execute: true });
  assert.equal(recovered.importedProfiles, 0);
  assert.equal(statSync(join(f.receipts, `${migrationId}.json`)).mode & 0o077, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM r03_legacy_content_candidate').get().count, 1);
});

test('tar symlinks and duplicate members fail before any extraction or target write', async t => {
  const f = fixture(t);
  symlinkSync('all-candidates.json', join(f.proactive, 'invented_link.json'));
  chmodSync(f.archivePath, 0o600);
  const tar = spawnSync('tar', ['-cf', f.archivePath, '-C', f.source,
    'agent-data/hh', 'agent-tokens', 'users'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  resign(f);
  await assert.rejects(runPrivateLegacyImport({ mode: 'check', configFile: f.configFile }),
    /private_legacy_import_unavailable/);
  assert.throws(() => statSync(f.config.targetDbPath), /ENOENT/);

  rmSync(join(f.proactive, 'invented_link.json'));
  chmodSync(f.archivePath, 0o600);
  const clean = spawnSync('tar', ['-cf', f.archivePath, '-C', f.source,
    'agent-data/hh', 'agent-tokens', 'users'], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  const duplicate = spawnSync('tar', ['-rf', f.archivePath, '-C', f.source,
    `agent-data/hh/${sourceRef}/proactive/all-candidates.json`], { encoding: 'utf8' });
  assert.equal(duplicate.status, 0, duplicate.stderr);
  resign(f);
  await assert.rejects(runPrivateLegacyImport({ mode: 'check', configFile: f.configFile }),
    /private_legacy_import_unavailable/);
  assert.throws(() => statSync(f.config.targetDbPath), /ENOENT/);
});

test('tar traversal and absolute member paths fail closed', async t => {
  const f = fixture(t);
  for (const maliciousName of ['../escape', '/absolute']) {
    const archive = readFileSync(f.archivePath);
    archive.fill(0, 0, 100);
    archive.write(maliciousName, 0, 'utf8');
    archive.fill(32, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += archive[i];
    archive.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
    archive[154] = 0; archive[155] = 32;
    chmodSync(f.archivePath, 0o600);
    writeFileSync(f.archivePath, archive);
    resign(f);
    await assert.rejects(runPrivateLegacyImport({ mode: 'check', configFile: f.configFile }),
      /private_legacy_import_unavailable/);
  }
  assert.throws(() => statSync(f.config.targetDbPath), /ENOENT/);
});
