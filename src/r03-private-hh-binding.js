import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedTar, digestPrivateFile, privateDirectory, readPrivateJson } from './r03-private-legacy-archive.js';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { encryptPrivateHhCredential } from './r03-private-hh-credential.js';
import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = () => { throw new Error('private_hh_binding_unavailable'); };

// Builds only explicitly owned profile material from a verified final archive.
// The output is a new owner-only staging tree; unowned historical scope files
// remain in the immutable archive and are never put in the live host config.
export async function preparePrivateHhBinding({ importConfigFile, outputRoot, secretsDirectory } = {}) {
  if (typeof outputRoot !== 'string' || !isAbsolute(outputRoot) || resolve(outputRoot) !== outputRoot ||
      typeof importConfigFile !== 'string' || !isAbsolute(importConfigFile) ||
      resolve(importConfigFile) !== importConfigFile || typeof secretsDirectory !== 'string' ||
      !isAbsolute(secretsDirectory) || resolve(secretsDirectory) !== secretsDirectory) fail();
  privateDirectory(dirname(outputRoot));
  let encryptionKey;
  try { encryptionKey = loadPrivateHostSecret(secretsDirectory, 'hh_encryption_key'); }
  catch { fail(); }
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) fail();
  const source = readPrivateJson(importConfigFile, 1024 * 1024);
  if (source?.version !== 'r03-private-legacy-import-v1' || !Array.isArray(source.profiles) ||
      !/^[a-f0-9]{64}$/.test(source.archiveSha256) ||
      !Number.isSafeInteger(source.archiveBytes)) fail();
  const manifest = readPrivateJson(source.manifestPath, 1024 * 1024);
  if (manifest.kind !== 'final_frozen' || manifest.migrationId !== source.migrationId ||
      manifest.sha256 !== source.archiveSha256 || manifest.bytes !== source.archiveBytes) fail();
  const digest = await digestPrivateFile(source.archivePath, 1024 * 1024 * 1024);
  if (digest.sha256 !== source.archiveSha256 || digest.bytes !== source.archiveBytes) fail();
  const members = new Set(checkedTar(source.archivePath));
  let created = false;
  try {
    mkdirSync(outputRoot, { mode: 0o700 }); created = true;
    const profiles = [];
    for (const row of source.profiles) {
      const old = row.sourceProfileRef;
      if (!safeId(old) || !safeId(row.profileId) || !Array.isArray(row.vacancyIds) ||
          !row.vacancyIds.length || row.vacancyIds.some(id => !safeId(id))) fail();
      const root = join(outputRoot, row.profileId);
      const contextDirectory = join(root, 'contexts');
      const proactiveDirectory = join(root, 'proactive');
      const tokenDirectory = join(root, 'tokens');
      for (const dir of [root, contextDirectory, proactiveDirectory, tokenDirectory])
        mkdirSync(dir, { mode: 0o700 });
      const readMember = (member, optional = false) => {
        if (!members.has(member)) { if (optional) return false; fail(); }
        const extracted = spawnSync('tar', ['-xOf', source.archivePath, member],
          { maxBuffer: 8 * 1024 * 1024 });
        if (extracted.status !== 0 || extracted.stdout.length > 8 * 1024 * 1024) fail();
        return extracted.stdout;
      };
      const copy = (member, target, optional = false) => {
        const bytes = readMember(member, optional);
        if (bytes === false) return false;
        writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        return true;
      };
      const legacyToken = readMember(`agent-tokens/${old}/hh`);
      writeFileSync(join(tokenDirectory, 'hh'),
        encryptPrivateHhCredential(legacyToken, encryptionKey), { flag: 'wx', mode: 0o600 });
      copy(`users/${old}/contexts/hh/active_vacancies.json`,
        join(contextDirectory, 'active_vacancies.json'));
      for (const id of row.vacancyIds) {
        copy(`users/${old}/contexts/hh/ats_config:${id}.json`,
          join(contextDirectory, `ats_config:${id}.json`), true);
        copy(`agent-data/hh/${old}/proactive/queries-${id}.json`,
          join(proactiveDirectory, `queries-${id}.json`), true);
        copy(`agent-data/hh/${old}/proactive/candidate-comments-${id}.json`,
          join(proactiveDirectory, `candidate-comments-${id}.json`), true);
      }
      profiles.push({ profileId: row.profileId, legacyUsername: old,
        vacancyIds: row.vacancyIds, contextDirectory, proactiveDirectory, tokenDirectory });
    }
    const configFile = join(outputRoot, 'host-config.json');
    writeFileSync(configFile, JSON.stringify({ version: 'r03-private-host-v1',
      dbPath: source.targetDbPath, profiles }) + '\n', { flag: 'wx', mode: 0o600 });
    const config = loadPrivateHostConfig(configFile);
    const loadPlan = createPrivateBaseSearchPlan({ resolveProfileBinding: config.resolveProfileBinding,
      isVacancyOwned: config.isVacancyOwned });
    let readyVacancies = 0;
    let blockedVacancies = 0;
    for (const row of profiles) for (const id of row.vacancyIds) {
      try { await loadPlan(row.profileId, id, { allowGeneration: false }); readyVacancies++; }
      catch { blockedVacancies++; }
    }
    return { status: 'bound', profileCount: profiles.length,
      ownedVacancies: readyVacancies + blockedVacancies, readyVacancies, blockedVacancies };
  } catch (error) {
    if (created) rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--import-config' && options.importConfigFile === undefined) options.importConfigFile = argv[++i];
    else if (arg === '--output-root' && options.outputRoot === undefined) options.outputRoot = argv[++i];
    else if (arg === '--secrets' && options.secretsDirectory === undefined) options.secretsDirectory = argv[++i];
    else fail();
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await preparePrivateHhBinding(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_hh_binding', ...result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_hh_binding', status: 'failed',
      code: 'private_hh_binding_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
