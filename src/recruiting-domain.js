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

export function listVacancyResponses(profileId, vacancyId) {
  const profile = getProfile(profileId);
  if (!profile || !profile.vacancyIds.includes(vacancyId)) return null;
  return profile.responses[vacancyId] ?? [];
}
