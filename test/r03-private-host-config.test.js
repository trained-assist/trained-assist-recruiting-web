import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrivateHostConfig, loadPrivateHostSecret } from '../src/r03-private-host-config.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-host-config-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['context', 'proactive', 'tokens', 'secrets'].map(name => {
    const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return [name, path];
  }));
  const configFile = join(root, 'config.json');
  const record = { version: 'r03-private-host-v1', dbPath: join(root, 'private.sqlite'),
    profiles: [{ profileId: 'profile_invented_001', vacancyIds: ['vacancy_invented_001'],
      contextDirectory: paths.context, proactiveDirectory: paths.proactive,
      tokenDirectory: paths.tokens }] };
  const writeConfig = value => writeFileSync(configFile, JSON.stringify(value), { mode: 0o600 });
  writeConfig(record);
  writeFileSync(join(paths.secrets, 'ladder_token'), 'invented_secret\n', { mode: 0o600 });
  return { root, paths, configFile, record, writeConfig };
}

test('owner-only private mapping binds a schedule profile and exact vacancy', async t => {
  const f = fixture(t);
  const loaded = loadPrivateHostConfig(f.configFile);
  assert.equal(loaded.dbPath, f.record.dbPath);
  assert.deepEqual(loaded.profileIds, ['profile_invented_001']);
  assert.deepEqual(await loaded.resolveProfileBinding('profile_invented_001'), {
    profileId: 'profile_invented_001', contextDirectory: f.paths.context,
    proactiveDirectory: f.paths.proactive, tokenDirectory: f.paths.tokens });
  assert.equal(await loaded.resolveProfileBinding('other_profile'), null);
  assert.equal(loaded.isVacancyOwned('profile_invented_001', 'vacancy_invented_001'), true);
  assert.equal(loaded.isVacancyOwned('other_profile', 'vacancy_invented_001'), false);
  assert.equal(loaded.isVacancyOwned('profile_invented_001', 'other_vacancy'), false);
  assert.equal(loaded.resolveLegacyProfile('profile_invented_001'), null, 'legacy links need an explicit mapping');
  assert.equal(loadPrivateHostSecret(f.paths.secrets, 'ladder_token'), 'invented_secret');
});

test('shared, symlinked, duplicate or malformed private configuration fails closed', t => {
  const f = fixture(t);
  chmodSync(f.configFile, 0o644);
  assert.throws(() => loadPrivateHostConfig(f.configFile), /private_host_config_unavailable/);
  chmodSync(f.configFile, 0o600);
  f.writeConfig({ ...f.record, profiles: [...f.record.profiles, f.record.profiles[0]] });
  assert.throws(() => loadPrivateHostConfig(f.configFile), /private_host_config_unavailable/);
  f.writeConfig(f.record);
  const link = join(f.root, 'config-link.json');
  symlinkSync(f.configFile, link);
  assert.throws(() => loadPrivateHostConfig(link), /private_host_config_unavailable/);
  chmodSync(f.paths.context, 0o755);
  assert.throws(() => loadPrivateHostConfig(f.configFile), /private_host_config_unavailable/);
  chmodSync(f.paths.context, 0o700);
  f.writeConfig({ ...f.record, profiles: [{ ...f.record.profiles[0], vacancyIds: ['../other'] }] });
  assert.throws(() => loadPrivateHostConfig(f.configFile), /private_host_config_unavailable/);
  f.writeConfig({ ...f.record, profiles: [
    { ...f.record.profiles[0], legacyUsername: 'old_login' },
    { ...f.record.profiles[0], profileId: 'other_profile', legacyUsername: 'old_login' }
  ] });
  assert.throws(() => loadPrivateHostConfig(f.configFile), /private_host_config_unavailable/);
});

test('secret reader rejects symlink, unsafe name and world-readable file', t => {
  const f = fixture(t);
  const secret = join(f.paths.secrets, 'ladder_token');
  chmodSync(secret, 0o644);
  assert.throws(() => loadPrivateHostSecret(f.paths.secrets, 'ladder_token'), /private_host_config_unavailable/);
  chmodSync(secret, 0o600);
  symlinkSync(secret, join(f.paths.secrets, 'linked_token'));
  assert.throws(() => loadPrivateHostSecret(f.paths.secrets, 'linked_token'), /private_host_config_unavailable/);
  assert.throws(() => loadPrivateHostSecret(f.paths.secrets, '../ladder_token'), /private_host_config_unavailable/);
});
