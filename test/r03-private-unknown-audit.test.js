import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { auditPrivateLegacyUnknowns } from '../src/r03-private-unknown-audit.js';

test('eight synthetic unknown jobs produce exact evidence and quarantine only', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-unknown-audit-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const privateDir = join(root, 'private'); mkdirSync(privateDir, { mode: 0o700 });
  const migrationId = 'invented_migration'; const profileId = 'invented_profile';
  const archivePath = join(privateDir, 'final.tar');
  writeFileSync(archivePath, 'invented archive bytes', { mode: 0o600 });
  const digest = filename => {
    const bytes = readFileSync(filename);
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const cronDbPath = join(privateDir, 'cron.sqlite');
  const old = new Database(cronDbPath);
  old.exec(`CREATE TABLE cron_jobs (id TEXT,profile_id TEXT,arguments_json TEXT,last_status TEXT,
    enabled INTEGER,last_run_at TEXT,action TEXT);
    CREATE TABLE action_executions (id TEXT,cron_id TEXT,status TEXT,scheduled_at TEXT,
    started_at TEXT,finished_at TEXT,result_json TEXT,error_json TEXT,created_at TEXT);`);
  for (let n = 0; n < 11; n++) {
    const vacancyId = `invented_vacancy_${n}`;
    old.prepare('INSERT INTO cron_jobs VALUES(?,?,?,?,?,?,?)').run(`invented_job_${n}`,
      profileId, JSON.stringify({ vacancy_id: vacancyId }), n < 8 ? 'unknown' : 'succeeded',
      0, '2026-10-06T00:00:00.000Z', 'hh_proactive_search');
    if (n < 8) old.prepare('INSERT INTO action_executions VALUES(?,?,?,?,?,?,?,?,?)').run(
      `invented_execution_${n}`, `invented_job_${n}`, 'unknown',
      '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:01.000Z',
      '2026-10-06T00:00:02.000Z', null, '{}', '2026-10-06T00:00:00.000Z');
  }
  old.close(); chmodSync(cronDbPath, 0o600);
  const targetDbPath = join(privateDir, 'candidate.sqlite');
  const target = new Database(targetDbPath);
  target.exec(`CREATE TABLE r03_legacy_content_snapshot (migration_id TEXT,profile_id TEXT,
    vacancy_id TEXT,source_file TEXT,searched_at TEXT,acceptance_status TEXT,payload TEXT);`);
  for (let n = 0; n < 8; n++) target.prepare('INSERT INTO r03_legacy_content_snapshot VALUES(?,?,?,?,?,?,?)').run(
    migrationId, profileId, `invented_vacancy_${n}`, `invented_snapshot_${n}.json`,
    '2026-10-06T00:00:05.000Z', 'quarantined', '{}');
  target.close(); chmodSync(targetDbPath, 0o600);
  const cronManifestPath = join(privateDir, 'cron-manifest.json');
  writeFileSync(cronManifestPath, JSON.stringify({ kind: 'cron_frozen', ...digest(cronDbPath),
    hhCronDefinitions: 11, enabled: 0, unknown: 8 }), { mode: 0o600 });
  const manifestPath = join(privateDir, 'final-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ kind: 'final_frozen', migrationId,
    ...digest(archivePath) }), { mode: 0o600 });
  const importConfigFile = join(privateDir, 'import-config.json');
  writeFileSync(importConfigFile, JSON.stringify({ version: 'r03-private-legacy-import-v1',
    migrationId, archivePath, manifestPath, archiveBytes: digest(archivePath).bytes,
    archiveSha256: digest(archivePath).sha256, targetDbPath,
    profiles: [{ sourceProfileRef: profileId, profileId,
      vacancyIds: Array.from({ length: 11 }, (_, n) => `invented_vacancy_${n}`) }] }),
  { mode: 0o600 });
  const outputFile = join(privateDir, 'unknown-receipt.json');
  const input = { importConfigFile, cronDbPath, cronManifestPath, outputFile };
  const expected = { status: 'quarantined', unknownDefinitions: 8,
    quarantinedDefinitions: 8, resolvedDefinitions: 0,
    linkedExecutions: 8, quarantinedSnapshots: 8 };
  assert.deepEqual(await auditPrivateLegacyUnknowns(input), expected);
  assert.deepEqual(await auditPrivateLegacyUnknowns(input), expected, 'byte-identical replay');
  const receipt = JSON.parse(readFileSync(outputFile, 'utf8'));
  assert.equal(receipt.jobs.length, 8);
  assert.ok(receipt.jobs.every(row => row.disposition === 'quarantined_ambiguous' &&
    row.history.at(-1).status === 'unknown' &&
    row.sourceSnapshots.every(snapshot => snapshot.acceptanceStatus === 'quarantined')));
  assert.doesNotMatch(JSON.stringify(expected), /invented_profile|invented_vacancy/);
});
