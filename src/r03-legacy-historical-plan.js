import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const parse = bytes => { try { return JSON.parse(bytes.toString('utf8')); } catch { return null; } };

// Historical evidence is never an accepted search receipt. These fingerprints
// describe the old payload; they do not reconstruct missing source revisions.
export function classifyLegacyHistoricalSnapshot({ row, rawBytes, sourceReceipt,
  isVacancyOwned, candidates, seen, currentPlan = null }) {
  const reasons = [];
  const add = (condition, reason) => { if (condition) reasons.push(reason); };
  let payload, ids;
  try { payload = JSON.parse(row.payload); ids = JSON.parse(row.candidate_ids); }
  catch { reasons.push('stored_payload_invalid'); }
  const profileId = row.profile_id;
  const vacancyId = row.vacancy_id;
  add(row.acceptance_status !== 'quarantined', 'unexpected_acceptance_status');
  add(!safeId(profileId) || !safeId(vacancyId) || !isVacancyOwned(profileId, vacancyId) ||
    row.unowned_vacancy === 1 || row.unbound_vacancy === 1, 'scope_unowned');
  add(typeof row.source_file !== 'string' || !row.source_file.endsWith(`-${vacancyId}.json`) ||
    row.filename_vacancy_mismatch === 1, 'source_filename_mismatch');
  add(!Buffer.isBuffer(rawBytes) || !sourceReceipt || rawBytes?.length !== sourceReceipt.bytes ||
    sha(rawBytes ?? Buffer.alloc(0)) !== sourceReceipt?.sha256, 'byte_receipt_mismatch');
  add(!payload || !Buffer.isBuffer(rawBytes) || !isDeepStrictEqual(parse(rawBytes),
    payload), 'source_payload_mismatch');
  add(!payload || String(payload?.vacancy_id) !== vacancyId || payload?.searched_at !== row.searched_at ||
    !Array.isArray(payload?.candidates) || !Array.isArray(ids) ||
    !isDeepStrictEqual(payload?.candidates?.map(item => item?.id), ids) ||
    new Set(ids ?? []).size !== ids?.length, 'candidate_list_mismatch');
  add(row.unbound_references > 0 || row.vacancy_mismatch_references > 0,
    'imported_candidate_anomaly');
  if (Array.isArray(ids)) for (const id of ids) {
    const member = candidates.get(id);
    add(!Array.isArray(member) || !member.includes(vacancyId), 'candidate_membership_missing');
    const firstSeenAt = seen.get(id);
    add(!firstSeenAt, 'seen_missing');
    add(Boolean(firstSeenAt && Date.parse(firstSeenAt) > Date.parse(row.searched_at)), 'seen_after_search');
  }
  add(!payload?.ats_config || String(payload.ats_config.vacancy_id) !== vacancyId, 'ats_unbound');
  add(!Array.isArray(payload?.search_queries) || payload.search_queries.length === 0,
    'queries_missing');
  const uniqueReasons = [...new Set(reasons)].sort();
  const historicalReadable = uniqueReasons.length === 0;
  const currentReady = Boolean(currentPlan && currentPlan.profileId === profileId &&
    currentPlan.vacancyId === vacancyId && currentPlan.queryCache?.pendingGeneration === false);
  const currentCriteriaMatch = currentReady && isDeepStrictEqual(currentPlan.atsConfig, payload?.ats_config);
  return { profileId, vacancyId, sourceFile: row.source_file, searchedAt: row.searched_at,
    candidateCount: Array.isArray(ids) ? ids.length : 0, reasons: uniqueReasons,
    historicalReadable, currentReady, currentCriteriaMatch,
    historicalCriteriaFingerprint: payload?.ats_config ? sha(JSON.stringify(payload.ats_config)) : null,
    historicalQueryFingerprint: Array.isArray(payload?.search_queries) ?
      sha(JSON.stringify([payload.search_queries, payload.search_area_ids ?? null])) : null,
    acceptanceBlockers: ['missing_occurrence_bound_receipt', 'missing_criteria_revision',
      'missing_source_revision'], accepted: false };
}

export function planLegacyHistoricalFeed(rows) {
  const reasons = {};
  for (const row of rows) for (const reason of row.reasons)
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  const latest = new Map();
  for (const row of rows.filter(item => item.historicalReadable && item.currentReady &&
      item.currentCriteriaMatch)) {
    const key = `${row.profileId}\0${row.vacancyId}`;
    const previous = latest.get(key);
    if (!previous || row.searchedAt > previous.searchedAt ||
      row.searchedAt === previous.searchedAt && row.sourceFile > previous.sourceFile) latest.set(key, row);
  }
  return { total: rows.length, historicalReadable: rows.filter(row => row.historicalReadable).length,
    blocked: rows.filter(row => !row.historicalReadable).length, reasons,
    currentReady: rows.filter(row => row.currentReady).length,
    currentCriteriaMatch: rows.filter(row => row.currentCriteriaMatch).length,
    recommendedLatest: [...latest.values()].sort((a, b) =>
      `${a.profileId}\0${a.vacancyId}`.localeCompare(`${b.profileId}\0${b.vacancyId}`)),
    accepted: 0 };
}
