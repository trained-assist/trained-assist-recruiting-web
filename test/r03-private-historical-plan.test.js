import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { legacyQueryConfigHash } from '../src/r03-private-base-plan.js';
import { planPrivateHistoricalFeed } from '../src/r03-private-historical-plan.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('private historical plan binds invented archive bytes and leaves SQLite unchanged on replay', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-historical-private-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); const stage = join(root, 'stage');
  mkdirSync(source, { mode: 0o700 }); mkdirSync(stage, { mode: 0o700 });
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, value, { mode: 0o600 }); };
  const profile = 'invented_profile', vacancy = 'invented_vacancy', resume = 'invented_resume';
  const file = `search-results-2026-01-02-${vacancy}.json`;
  const ats = { vacancy_id: vacancy, vacancy_title: 'Вымышленный инженер',
    vacancy_context: 'Вымышленный клиент', filters: { area: { id: '1' } },
    required: [{ name: 'инженер', weight: 1 }], knockout: [] };
  const searchedAt = '2026-01-02T07:00:00.000Z';
  const payload = { vacancy_id: vacancy, searched_at: searchedAt, ats_config: ats,
    search_queries: ['вымышленный инженер'], candidates: [{ id: resume }] };
  const raw = Buffer.from(JSON.stringify(payload));
  put(join(source, 'agent-data', 'hh', profile, 'proactive', file), raw);
  const archivePath = join(stage, 'final.tar');
  execFileSync('tar', ['-cf', archivePath, '-C', source, 'agent-data/hh']);
  chmodSync(archivePath, 0o600);
  const archive = readFileSync(archivePath);
  const migrationId = 'invented_final';
  const manifestPath = join(stage, 'manifest.json');
  put(manifestPath, JSON.stringify({ kind: 'final_frozen', migrationId,
    bytes: archive.length, sha256: sha(archive) }));
  const dbPath = join(stage, 'candidate.sqlite');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE r03_legacy_content_import (migration_id TEXT, profile_id TEXT,
    source_receipts TEXT, counts TEXT);
    CREATE TABLE r03_legacy_content_candidate (migration_id TEXT, profile_id TEXT,
      resume_id TEXT, vacancy_ids TEXT);
    CREATE TABLE r03_legacy_content_snapshot (migration_id TEXT, profile_id TEXT,
      source_file TEXT, vacancy_id TEXT, searched_at TEXT, candidate_ids TEXT, payload TEXT,
      acceptance_status TEXT, unowned_vacancy INTEGER, unbound_vacancy INTEGER,
      filename_vacancy_mismatch INTEGER, unbound_references INTEGER,
      vacancy_mismatch_references INTEGER);
    CREATE TABLE real_hh_seen (profile_id TEXT, vacancy_id TEXT, resume_id TEXT,
      first_seen_at TEXT);`);
  db.prepare('INSERT INTO r03_legacy_content_import VALUES(?,?,?,?)').run(migrationId, profile,
    JSON.stringify([{ file, bytes: raw.length, sha256: sha(raw) }]), JSON.stringify({ snapshots: 1 }));
  db.prepare('INSERT INTO r03_legacy_content_candidate VALUES(?,?,?,?)').run(migrationId,
    profile, resume, JSON.stringify([vacancy]));
  db.prepare('INSERT INTO r03_legacy_content_snapshot VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    migrationId, profile, file, vacancy, searchedAt, JSON.stringify([resume]),
    JSON.stringify(payload), 'quarantined', 0, 0, 0, 0, 0);
  db.prepare('INSERT INTO real_hh_seen VALUES(?,?,?,?)').run(profile, vacancy, resume,
    '2026-01-01T00:00:00.000Z');
  db.close(); chmodSync(dbPath, 0o600);
  const context = join(stage, 'context'), proactive = join(stage, 'proactive'),
    tokens = join(stage, 'tokens');
  for (const dir of [context, proactive, tokens]) mkdirSync(dir, { mode: 0o700 });
  put(join(context, `ats_config:${vacancy}.json`), JSON.stringify({ value: JSON.stringify(ats) }));
  put(join(proactive, `queries-${vacancy}.json`), JSON.stringify({ vacancy_id: vacancy,
    queries: ['вымышленный инженер'], config_hash: legacyQueryConfigHash(ats) }));
  const hostConfigFile = join(stage, 'host-config.json');
  put(hostConfigFile, JSON.stringify({ version: 'r03-private-host-v1', dbPath,
    profiles: [{ profileId: profile, legacyUsername: profile, vacancyIds: [vacancy],
      contextDirectory: context, proactiveDirectory: proactive, tokenDirectory: tokens }] }));
  const importConfigFile = join(stage, 'import-config.json');
  put(importConfigFile, JSON.stringify({ version: 'r03-private-legacy-import-v1',
    migrationId, archivePath, archiveBytes: archive.length, archiveSha256: sha(archive),
    manifestPath, targetDbPath: dbPath, profiles: [{ sourceProfileRef: profile,
      profileId: profile, vacancyIds: [vacancy] }] }));
  const outputFile = join(stage, 'receipt.json');
  const input = { importConfigFile, hostConfigFile, outputFile };
  const before = sha(readFileSync(dbPath));
  const expected = { total: 1, historicalReadable: 1, blocked: 0, reasons: {},
    currentReady: 1, currentCriteriaMatch: 1, recommendedLatest: 1, accepted: 0 };
  assert.deepEqual(await planPrivateHistoricalFeed(input), expected);
  assert.deepEqual(await planPrivateHistoricalFeed(input), expected);
  assert.equal(sha(readFileSync(dbPath)), before);
  assert.equal(statSync(outputFile).mode & 0o777, 0o600);
  const receipt = JSON.parse(readFileSync(outputFile));
  assert.equal(receipt.rows[0].accepted, false);
  assert.equal(receipt.recommendedLatest.length, 1);
});
