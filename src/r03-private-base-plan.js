import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeHhAtsConfig } from './hh-resume-mapping.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const fail = () => { throw new Error('private_search_plan_unavailable'); };

function readPrivateJson(directory, name, optional = false) {
  try {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).mode & 0o077) fail();
    const filename = join(directory, name);
    let descriptor;
    try {
      descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) fail();
      const bytes = readFileSync(descriptor);
      if (bytes.length !== info.size) fail();
      return JSON.parse(bytes.toString('utf8'));
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    fail();
  }
}

function contextValue(record) {
  if (!object(record) || !Object.hasOwn(record, 'value')) fail();
  let value = record.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { fail(); }
  }
  return value;
}

function normalizedForLegacyHash(config) {
  const normalized = normalizeHhAtsConfig(config);
  return { vacancy_title: normalized.vacancyTitle,
    vacancy_context: config.vacancy_context,
    required: normalized.required, preferred: normalized.preferred, knockout: normalized.knockout };
}

// This is the exact old generated-query cache key. Manual pinned queries do
// not use it, but generated caches must match before HH dispatch.
export function legacyQueryConfigHash(config, exclusions = []) {
  const normalized = normalizedForLegacyHash(config);
  const key = JSON.stringify({ title: normalized.vacancy_title, context: normalized.vacancy_context,
    recruiter_prompt: '', required: normalized.required.map(item => item.name).sort(),
    preferred: normalized.preferred.map(item => item.name).sort(),
    knockout: [...normalized.knockout].sort(), exclusions: [...exclusions].sort() });
  return createHash('md5').update(key).digest('hex').slice(0, 12);
}

function commentsForHash(directory, vacancyId) {
  const record = readPrivateJson(directory, `candidate-comments-${vacancyId}.json`, true);
  if (record === null) return [];
  if (!object(record) || Object.values(record).some(value => !object(value) ||
      value.text !== undefined && typeof value.text !== 'string')) fail();
  return Object.values(record).map(value => (value.text || '').trim()).filter(Boolean);
}

function vacancyFromContext(directory, vacancyId) {
  for (const name of ['active_vacancies.json', 'active_vacancy.json']) {
    const record = readPrivateJson(directory, name, true);
    if (record === null) continue;
    const value = contextValue(record);
    const rows = Array.isArray(value) ? value : [value];
    const matching = rows.filter(row => object(row) && String(row.id) === vacancyId);
    if (matching.length > 1) fail();
    if (matching.length) return matching[0];
  }
  return null;
}

export function createPrivateBaseSearchPlan({ resolveProfileBinding, isVacancyOwned }) {
  if (typeof resolveProfileBinding !== 'function' || typeof isVacancyOwned !== 'function')
    throw new TypeError('private profile binding ports required');
  return async (profileId, vacancyId) => {
    if (!safeId(profileId) || !safeId(vacancyId) || !isVacancyOwned(profileId, vacancyId)) fail();
    let binding;
    try { binding = await resolveProfileBinding(profileId); } catch { fail(); }
    if (binding?.profileId !== profileId || typeof binding.contextDirectory !== 'string' ||
        typeof binding.proactiveDirectory !== 'string' || !binding.contextDirectory || !binding.proactiveDirectory) fail();
    const config = contextValue(readPrivateJson(binding.contextDirectory, `ats_config:${vacancyId}.json`));
    if (!object(config) || config.vacancy_id !== undefined && String(config.vacancy_id) !== vacancyId) fail();
    try { normalizeHhAtsConfig(config); } catch { fail(); }
    const queryRecord = readPrivateJson(binding.proactiveDirectory, `queries-${vacancyId}.json`);
    if (!object(queryRecord) || String(queryRecord.vacancy_id) !== vacancyId ||
        !Array.isArray(queryRecord.queries) || queryRecord.queries.length < 1 || queryRecord.queries.length > 15 ||
        queryRecord.queries.some(query => typeof query !== 'string' || !query.trim() || query !== query.trim() || query.length > 500) ||
        new Set(queryRecord.queries).size !== queryRecord.queries.length ||
        queryRecord.manual !== undefined && typeof queryRecord.manual !== 'boolean') fail();
    const manual = queryRecord.manual === true;
    if (!manual && queryRecord.config_hash !== legacyQueryConfigHash(config,
      commentsForHash(binding.proactiveDirectory, vacancyId))) fail();
    const vacancy = vacancyFromContext(binding.contextDirectory, vacancyId);
    const has = (value, key) => Object.hasOwn(value ?? {}, key);
    const area = has(config.filters, 'area') ? config.filters.area : has(config, 'area') ? config.area
      : has(vacancy, 'area') ? vacancy.area : undefined;
    if (area === undefined) fail();
    return { profileId, vacancyId, criteriaRevision: `criteria-${sha(config)}`,
      queryCache: { revision: `queries-${sha([queryRecord.queries, queryRecord.config_hash, manual])}`,
        queries: [...queryRecord.queries], manual }, atsConfig: config, area };
  };
}
