import { createHash } from 'node:crypto';

const own = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = (code) => { throw new Error(code); };
const unique = (items) => new Set(items).size === items.length;

// This projection only runs inside the private migration process. It deliberately
// returns references, not names, resumes, queries, comments, ATS text or tokens.
// The caller passes these references directly to R03LegacyRehearsal and must never
// log or publish the envelope.
export function projectLegacyR03Sources({ sourceProfileRef, allCandidates, seenIds,
  snapshots = [], queryCaches = [], comments = [], atsConfigs = [], schedules = [] }) {
  if (typeof sourceProfileRef !== 'string' || !sourceProfileRef || sourceProfileRef.length > 256 ||
      /[\x00-\x1f\/\\]/.test(sourceProfileRef) || !own(allCandidates) || !own(seenIds) || !Array.isArray(snapshots) ||
      !Array.isArray(queryCaches) || !Array.isArray(comments) || !Array.isArray(atsConfigs) ||
      !Array.isArray(schedules)) fail('invalid_legacy_source_bundle');

  const projectedCandidates = Object.entries(allCandidates).map(([resumeId, record]) => {
    if (!safeId(resumeId) || !own(record) || !safeId(record.id) || record.id !== resumeId ||
        record.vacancy_ids !== undefined && (!Array.isArray(record.vacancy_ids) ||
          record.vacancy_ids.some(id => !safeId(id)))) fail('invalid_legacy_candidate_source');
    const vacancyIds = record.vacancy_ids || [];
    if (!unique(vacancyIds)) fail('duplicate_legacy_candidate_vacancy');
    return { resumeId, vacancyIds };
  });

  const projectedSeen = [];
  for (const [vacancyId, entries] of Object.entries(seenIds)) {
    if (!safeId(vacancyId) || !own(entries)) fail('invalid_legacy_seen_source');
    for (const [resumeId, firstSeenAt] of Object.entries(entries)) {
      if (!safeId(resumeId) || !validTime(firstSeenAt)) fail('invalid_legacy_seen_source');
      projectedSeen.push({ vacancyId, resumeId, firstSeenAt });
    }
  }

  const projectedSnapshots = snapshots.map(({ filename, value }) => {
    if (typeof filename !== 'string' || !/^search-results-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]+\.json$/.test(filename) ||
        !own(value) || !safeId(value.vacancy_id) || !validTime(value.searched_at) ||
        !Array.isArray(value.candidates) || value.candidates.length > 50_000) fail('invalid_legacy_snapshot_source');
    const vacancyId = String(value.vacancy_id);
    if (!filename.endsWith(`-${vacancyId}.json`)) fail('legacy_snapshot_vacancy_mismatch');
    const candidateIds = value.candidates.map(candidate => {
      if (!own(candidate) || !safeId(candidate.id)) fail('invalid_legacy_snapshot_candidate');
      return candidate.id;
    });
    if (!unique(candidateIds)) fail('duplicate_legacy_snapshot_candidate');
    // Snapshot files do not contain a durable job ID. Derive a stable migration
    // reference from the profile, filename and timestamp; do not invent an
    // accepted scheduled/manual receipt from this historical reference.
    const jobId = `legacy_${createHash('sha256').update(JSON.stringify([
      sourceProfileRef, filename, value.searched_at])).digest('hex').slice(0, 32)}`;
    return { jobId, vacancyId, searchedAt: value.searched_at, candidateIds };
  });

  const projectedQueries = queryCaches.map(({ vacancyId, value }) => {
    if (!safeId(vacancyId) || !own(value) || !safeId(value.vacancy_id) || value.vacancy_id !== vacancyId ||
        !Array.isArray(value.queries) || value.queries.some(query => typeof query !== 'string') ||
        value.queries.length > 15 || value.manual !== undefined && typeof value.manual !== 'boolean')
      fail('invalid_legacy_query_source');
    return { vacancyId, manual: value.manual === true, queryCount: value.queries.length };
  });

  const projectedComments = comments.flatMap(({ vacancyId, value }) => {
    if (!safeId(vacancyId) || !own(value)) fail('invalid_legacy_comment_source');
    return Object.entries(value).map(([resumeId, comment]) => {
      if (!safeId(resumeId) || !own(comment) || comment.text !== undefined && typeof comment.text !== 'string')
        fail('invalid_legacy_comment_source');
      return { vacancyId, resumeId };
    });
  });

  const projectedAts = atsConfigs.map(({ vacancyId, value }) => {
    if (!safeId(vacancyId) || !own(value)) fail('invalid_legacy_ats_source');
    let config = value.value;
    if (typeof config === 'string') {
      try { config = JSON.parse(config); } catch { fail('invalid_legacy_ats_source'); }
    }
    if (!own(config) || config.vacancy_id !== undefined && String(config.vacancy_id) !== vacancyId)
      fail('invalid_legacy_ats_source');
    return { vacancyId };
  });

  return { sourceProfileRef, allCandidates: projectedCandidates, seenIds: projectedSeen,
    snapshots: projectedSnapshots, queryCaches: projectedQueries,
    comments: projectedComments, atsConfigs: projectedAts, schedules };
}

export function legacyR03ExpectedCounts(profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) fail('invalid_legacy_source_profiles');
  const categories = ['allCandidates', 'seenIds', 'snapshots', 'queryCaches', 'comments', 'atsConfigs', 'schedules'];
  return Object.fromEntries(categories.map(category => [category,
    profiles.reduce((sum, profile) => sum + profile[category].length, 0)]));
}
