import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeHhAtsConfig } from './hh-resume-mapping.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const fail = () => { throw new Error('private_search_plan_unavailable'); };
const validQueries = queries => Array.isArray(queries) && queries.length >= 1 && queries.length <= 15 &&
  queries.every(query => typeof query === 'string' && query.trim() === query && query.length > 0 && query.length <= 500) &&
  new Set(queries).size === queries.length;

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

export function createPrivateBaseSearchPlan({ resolveProfileBinding, isVacancyOwned,
  generateQueries, queryCache, queryOverrides } = {}) {
  if (typeof resolveProfileBinding !== 'function' || typeof isVacancyOwned !== 'function')
    throw new TypeError('private profile binding ports required');
  if ((generateQueries === undefined) !== (queryCache === undefined) ||
      generateQueries !== undefined && (typeof generateQueries !== 'function' ||
        typeof queryCache?.get !== 'function' || typeof queryCache?.store !== 'function'))
    throw new TypeError('private query regeneration ports required together');
  if (queryOverrides !== undefined && typeof queryOverrides?.get !== 'function')
    throw new TypeError('private query override port required');
  return async (profileId, vacancyId) => {
    if (!safeId(profileId) || !safeId(vacancyId) || !isVacancyOwned(profileId, vacancyId)) fail();
    let binding;
    try { binding = await resolveProfileBinding(profileId); } catch { fail(); }
    if (binding?.profileId !== profileId || typeof binding.contextDirectory !== 'string' ||
        typeof binding.proactiveDirectory !== 'string' || !binding.contextDirectory || !binding.proactiveDirectory) fail();
    const config = contextValue(readPrivateJson(binding.contextDirectory, `ats_config:${vacancyId}.json`));
    if (!object(config) || config.vacancy_id !== undefined && String(config.vacancy_id) !== vacancyId) fail();
    try { normalizeHhAtsConfig(config); } catch { fail(); }
    let queryRecord = readPrivateJson(binding.proactiveDirectory, `queries-${vacancyId}.json`, true);
    if (queryRecord !== null && (!object(queryRecord) || String(queryRecord.vacancy_id) !== vacancyId ||
        !validQueries(queryRecord.queries) ||
        queryRecord.manual !== undefined && typeof queryRecord.manual !== 'boolean')) fail();
    const comments = commentsForHash(binding.proactiveDirectory, vacancyId);
    const configHash = legacyQueryConfigHash(config, comments);
    let override;
    try { override = queryOverrides?.get(profileId, vacancyId) ?? { revision: 0, mode: 'source' }; }
    catch { fail(); }
    if (!Number.isSafeInteger(override.revision) || override.revision < 0 ||
        !['source', 'manual', 'reset'].includes(override.mode)) fail();
    if (override.mode === 'manual') {
      if (!validQueries(override.queries)) fail();
      queryRecord = { vacancy_id: vacancyId, queries: override.queries, config_hash: 'manual', manual: true };
    }
    if (override.mode === 'reset') queryRecord = null;
    const effectiveHash = override.mode === 'reset' ? createHash('md5')
      .update(JSON.stringify([configHash, override.revision])).digest('hex').slice(0, 12) : configHash;
    if (!queryRecord || queryRecord.manual !== true && queryRecord.config_hash !== configHash) {
      if (generateQueries === undefined) fail();
      let queries;
      try {
        queries = queryCache.get(profileId, vacancyId, effectiveHash);
        if (queries === null) queries = queryCache.store(profileId, vacancyId, effectiveHash,
          await generateQueries({ profileId, vacancyId, atsConfig: config, comments,
            baseQueries: queryRecord?.queries ?? [] }));
      } catch { fail(); }
      if (!validQueries(queries)) fail();
      queryRecord = { vacancy_id: vacancyId, queries, config_hash: effectiveHash, manual: false };
    }
    const manual = queryRecord.manual === true;
    const vacancy = vacancyFromContext(binding.contextDirectory, vacancyId);
    const has = (value, key) => Object.hasOwn(value ?? {}, key);
    const area = has(config.filters, 'area') ? config.filters.area : has(config, 'area') ? config.area
      : has(vacancy, 'area') ? vacancy.area : undefined;
    if (area === undefined) fail();
    return { profileId, vacancyId, criteriaRevision: `criteria-${sha(config)}`,
      queryCache: { revision: `queries-${sha([queryRecord.queries, queryRecord.config_hash, manual, override.revision])}`,
        queries: [...queryRecord.queries], manual }, atsConfig: config, area };
  };
}
