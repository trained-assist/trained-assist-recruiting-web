import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vacancies = JSON.parse(await readFile(join(root, 'data/vacancies.json'), 'utf8'));
const profileData = JSON.parse(await readFile(join(root, 'data/profile-scenarios.json'), 'utf8'));
const profileById = new Map(profileData.profiles.map(profile => [profile.id, profile]));
const vacancyById = new Map(vacancies.map(vacancy => [vacancy.id, vacancy]));

export function getProfile(profileId) {
  return profileById.get(profileId) ?? null;
}

export function profileHasScope(profileId, scope) {
  return getProfile(profileId)?.scopes.includes(scope) ?? false;
}

export function listProfileVacancies(profileId) {
  const profile = getProfile(profileId);
  if (!profile) return null;
  return profile.vacancyIds.map(id => vacancyById.get(id)).filter(Boolean);
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const value = JSON.parse(decoded);
    if (encodeCursor(value) !== cursor) return null;
    const expectedKeys = ['offset', 'profileId', 'revision', 'vacancyId'];
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) ||
        !Number.isInteger(value.offset) || value.offset < 0 ||
        typeof value.profileId !== 'string' || typeof value.vacancyId !== 'string' || typeof value.revision !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

export function readVacancyResponses(profileId, vacancyId, { limit, cursor }) {
  const profile = getProfile(profileId);
  if (!profile || !profile.vacancyIds.includes(vacancyId)) return null;
  const collection = profile.responses[vacancyId];
  if (!collection) return null;

  let offset = 0;
  if (cursor !== null && cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    if (!decoded || decoded.profileId !== profileId || decoded.vacancyId !== vacancyId) return { kind: 'invalid_cursor' };
    if (decoded.revision !== collection.revision) {
      return { kind: 'stale_cursor', requestedRevision: decoded.revision, currentRevision: collection.revision };
    }
    if (decoded.offset >= collection.items.length) return { kind: 'invalid_cursor' };
    offset = decoded.offset;
  }

  const end = Math.min(offset + limit, collection.items.length);
  const items = collection.items.slice(offset, end);
  const nextCursor = end < collection.items.length
    ? encodeCursor({ profileId, vacancyId, revision: collection.revision, offset: end })
    : null;
  return { kind: 'page', revision: collection.revision, freshness: 'current', items, nextCursor };
}
