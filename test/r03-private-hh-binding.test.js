import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { preparePrivateHhBinding } from '../src/r03-private-hh-binding.js';
import { legacyQueryConfigHash } from '../src/r03-private-base-plan.js';

test('verified frozen archive restores only owned scope to owner-only host binding', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-hh-bind-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); const stage = join(root, 'stage');
  mkdirSync(source, { mode: 0o700 }); mkdirSync(stage, { mode: 0o700 });
  const profile = 'invented_profile'; const owned = 'invented_owned'; const unowned = 'invented_unowned';
  const ats = { vacancy_id: owned, vacancy_title: 'Вымышленный инженер',
    vacancy_context: 'Вымышленный клиент', filters: { area: { id: '1' } },
    required: [{ name: 'инженер', weight: 1 }], knockout: [] };
  const put = (path, value) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, value, { mode: 0o600 });
  };
  put(join(source, 'agent-tokens', profile, 'hh'), 'invented_token');
  put(join(source, 'users', profile, 'contexts', 'hh', 'active_vacancies.json'),
    JSON.stringify({ value: JSON.stringify([{ id: owned }]) }));
  put(join(source, 'users', profile, 'contexts', 'hh', `ats_config:${owned}.json`),
    JSON.stringify({ value: JSON.stringify(ats) }));
  put(join(source, 'agent-data', 'hh', profile, 'proactive', `queries-${owned}.json`),
    JSON.stringify({ vacancy_id: owned, queries: ['вымышленный инженер'],
      config_hash: legacyQueryConfigHash(ats) }));
  put(join(source, 'agent-data', 'hh', profile, 'proactive', `queries-${unowned}.json`),
    JSON.stringify({ vacancy_id: unowned, queries: ['historical only'], manual: true }));
  const archivePath = join(stage, 'final.tar');
  execFileSync('tar', ['-cf', archivePath, '-C', source, 'agent-data/hh', 'agent-tokens', 'users']);
  chmodSync(archivePath, 0o600);
  const archive = readFileSync(archivePath);
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const migrationId = 'invented_final';
  const manifestPath = join(stage, 'manifest.json');
  put(manifestPath, JSON.stringify({ kind: 'final_frozen', migrationId,
    bytes: archive.length, sha256: archiveSha256 }));
  const importConfigFile = join(stage, 'import-config.json');
  put(importConfigFile, JSON.stringify({ version: 'r03-private-legacy-import-v1',
    migrationId, archivePath, archiveBytes: archive.length, archiveSha256, manifestPath,
    targetDbPath: join(stage, 'candidate.sqlite'), profiles: [{ sourceProfileRef: profile,
      profileId: profile, vacancyIds: [owned], quarantinedSourceVacancyIds: [unowned] }] }));
  const outputRoot = join(stage, 'host');
  assert.deepEqual(await preparePrivateHhBinding({ importConfigFile, outputRoot }),
    { status: 'bound', profileCount: 1, ownedVacancies: 1, readyVacancies: 1, blockedVacancies: 0 });
  assert.equal(statSync(outputRoot).mode & 0o777, 0o700);
  assert.equal(statSync(join(outputRoot, 'host-config.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(outputRoot, profile, 'tokens', 'hh')).mode & 0o777, 0o600);
  assert.equal(existsSync(join(outputRoot, profile, 'proactive', `queries-${unowned}.json`)), false);
});
