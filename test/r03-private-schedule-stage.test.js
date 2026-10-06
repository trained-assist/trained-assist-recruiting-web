import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { stagePrivateLegacySchedules } from '../src/r03-private-schedule-stage.js';

test('real-format 11 disabled definitions stage only in disposable copy with eight unknown blocks', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-schedule-stage-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['source', 'contexts', 'proactive', 'tokens'].map(name => {
    const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return [name, path];
  }));
  const put = (name, value) => {
    const path = join(dirs.source, name);
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path;
  };
  const digest = path => {
    const bytes = readFileSync(path);
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const profileId = 'invented_profile'; const migrationId = 'invented_migration';
  const vacancyIds = Array.from({ length: 11 }, (_, n) => `invented_vacancy_${n}`);
  const targetDbPath = join(dirs.source, 'candidate.sqlite');
  const target = new Database(targetDbPath);
  target.exec('CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES (\'migration intact\')');
  target.close(); chmodSync(targetDbPath, 0o600);
  const hostConfigFile = put('host-config.json', { version: 'r03-private-host-v1',
    dbPath: targetDbPath, profiles: [{ profileId, legacyUsername: profileId, vacancyIds,
      contextDirectory: dirs.contexts, proactiveDirectory: dirs.proactive,
      tokenDirectory: dirs.tokens }] });
  const archivePath = join(dirs.source, 'final.tar');
  writeFileSync(archivePath, 'invented archive', { mode: 0o600 });
  const manifestPath = put('manifest.json', { kind: 'final_frozen', migrationId,
    ...digest(archivePath) });
  const importConfigFile = put('import-config.json', { version: 'r03-private-legacy-import-v1',
    migrationId, archivePath, manifestPath, archiveBytes: digest(archivePath).bytes,
    archiveSha256: digest(archivePath).sha256, targetDbPath });
  const cronDbPath = join(dirs.source, 'cron.sqlite');
  const cron = new Database(cronDbPath);
  cron.exec(`CREATE TABLE cron_jobs (id TEXT,profile_id TEXT,name TEXT,schedule TEXT,
    timezone TEXT,action TEXT,arguments_json TEXT,enabled INTEGER,last_status TEXT);`);
  for (let n = 0; n < 11; n++) cron.prepare('INSERT INTO cron_jobs VALUES(?,?,?,?,?,?,?,?,?)').run(
    `invented_job_${n}`, profileId, `cold-search:${vacancyIds[n]}`, '0 9 * * *',
    'Europe/Moscow', 'hh_proactive_search', JSON.stringify({ vacancy_id: vacancyIds[n] }),
    0, n < 8 ? 'unknown' : 'succeeded');
  cron.close(); chmodSync(cronDbPath, 0o600);
  const cronManifestPath = put('cron-manifest.json', { kind: 'cron_frozen',
    ...digest(cronDbPath), hhCronDefinitions: 11, unknown: 8, enabled: 0 });
  const unknownReceiptFile = put('unknown-receipt.json', {
    version: 'r03-private-unknown-audit-v1', migrationId,
    archiveSha256: digest(archivePath).sha256, cronSha256: digest(cronDbPath).sha256,
    jobs: vacancyIds.slice(0, 8).map((_, n) => ({ legacyJobId: `invented_job_${n}`,
      profileId, disposition: 'quarantined_ambiguous' })) });
  const outputDirectory = join(root, 'disposable');
  const result = await stagePrivateLegacySchedules({ hostConfigFile, importConfigFile,
    cronDbPath, cronManifestPath, unknownReceiptFile, outputDirectory,
    clock: () => new Date('2026-10-06T08:00:00.000Z') });
  assert.deepEqual(result, { status: 'staged', imported: 11, unknownQuarantined: 8, enabled: 0 });
  const original = new Database(targetDbPath, { readonly: true });
  assert.equal(original.prepare('SELECT value FROM sentinel').get().value, 'migration intact');
  assert.equal(original.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='cold_search_schedules'").get().n, 0);
  original.close();
  const disposable = new Database(join(outputDirectory, 'candidate.sqlite'), { readonly: true });
  assert.equal(disposable.prepare('SELECT COUNT(*) AS n FROM cold_search_schedules').get().n, 11);
  assert.equal(disposable.prepare('SELECT COUNT(*) AS n FROM cold_search_schedules WHERE enabled=1').get().n, 0);
  assert.equal(disposable.prepare('SELECT COUNT(*) AS n FROM cold_search_occurrences').get().n, 0);
  disposable.close();
  assert.equal(JSON.parse(readFileSync(join(outputDirectory, 'receipt.json'))).status, 'disposable_only');
});
