import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('private_host_config_unavailable'); };

function privateDirectory(path) {
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path ||
        realpathSync(path) !== path || !lstatSync(path).isDirectory() ||
        lstatSync(path).mode & 0o077) fail();
  } catch { fail(); }
}

function privateFile(path, maxBytes) {
  privateDirectory(dirname(path));
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.mode & 0o077 || info.size < 1 || info.size > maxBytes) fail();
    const bytes = readFileSync(fd);
    if (bytes.length !== info.size) fail();
    return bytes.toString('utf8');
  } catch { fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function loadPrivateHostConfig(filename) {
  if (typeof filename !== 'string' || !isAbsolute(filename) || resolve(filename) !== filename) fail();
  let record;
  try { record = JSON.parse(privateFile(filename, 1024 * 1024)); } catch { fail(); }
  if (!object(record) || Object.keys(record).sort().join(',') !== 'dbPath,profiles,version' ||
      record.version !== 'r03-private-host-v1' || typeof record.dbPath !== 'string' ||
      !isAbsolute(record.dbPath) || resolve(record.dbPath) !== record.dbPath ||
      !Array.isArray(record.profiles) || record.profiles.length < 1 || record.profiles.length > 100) fail();
  privateDirectory(dirname(record.dbPath));
  try {
    const info = lstatSync(record.dbPath);
    if (!info.isFile() || info.mode & 0o077) fail();
  } catch (error) { if (error?.code !== 'ENOENT') fail(); }
  const bindings = new Map();
  const legacyProfiles = new Map();
  for (const row of record.profiles) {
    if (!object(row) || !['contextDirectory,proactiveDirectory,profileId,tokenDirectory,vacancyIds',
      'contextDirectory,legacyUsername,proactiveDirectory,profileId,tokenDirectory,vacancyIds']
      .includes(Object.keys(row).sort().join(',')) ||
        !safeId(row.profileId) || bindings.has(row.profileId) ||
        row.legacyUsername !== undefined && (!safeId(row.legacyUsername) || legacyProfiles.has(row.legacyUsername)) ||
        !Array.isArray(row.vacancyIds) || row.vacancyIds.length < 1 || row.vacancyIds.length > 1000 ||
        row.vacancyIds.some(id => !safeId(id)) || new Set(row.vacancyIds).size !== row.vacancyIds.length) fail();
    for (const path of [row.contextDirectory, row.proactiveDirectory, row.tokenDirectory])
      privateDirectory(path);
    bindings.set(row.profileId, { profileId: row.profileId,
      contextDirectory: row.contextDirectory, proactiveDirectory: row.proactiveDirectory,
      tokenDirectory: row.tokenDirectory, vacancyIds: new Set(row.vacancyIds) });
    if (row.legacyUsername !== undefined) legacyProfiles.set(row.legacyUsername, row.profileId);
  }
  return {
    dbPath: record.dbPath,
    profileIds: [...bindings.keys()],
    resolveLegacyProfile: username => legacyProfiles.get(username) ?? null,
    isWebProfileMapped: profileId => [...legacyProfiles.values()].includes(profileId),
    resolveProfileBinding: async profileId => {
      const row = bindings.get(profileId);
      return row ? { profileId: row.profileId, contextDirectory: row.contextDirectory,
        proactiveDirectory: row.proactiveDirectory, tokenDirectory: row.tokenDirectory } : null;
    },
    vacancyIdsForProfile: profileId => [...(bindings.get(profileId)?.vacancyIds ?? [])],
    isVacancyOwned: (profileId, vacancyId) => bindings.get(profileId)?.vacancyIds.has(vacancyId) === true
  };
}

export function loadPrivateHostSecret(directory, name) {
  if (!safeId(name)) fail();
  const value = privateFile(`${directory}/${name}`, 16_000).trim();
  if (!value || (name === 'hh_user_agent' ? /[\x00-\x1f\x7f]/.test(value) : /\s/.test(value))) fail();
  return value;
}
