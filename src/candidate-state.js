import { createHash } from 'node:crypto';

// R-03 state contract v1. The in-memory adapter is for contract tests only; a live
// adapter must commit the candidate pool, seen ledger and snapshot atomically.
export const CANDIDATE_STATE_VERSION = 'v1';
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const isoUtc = value => typeof value === 'string' && /^202[0-9]-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const bucket = (object, key) => object[key] ??= {};
const statuses = new Set(['active', 'starred', 'archived']);

function emptyState(profileId) {
  return { stateVersion: CANDIDATE_STATE_VERSION, profileId, candidates: {}, seenByVacancy: {}, snapshotsByVacancy: {}, commentsByVacancy: {}, queriesByVacancy: {} };
}

function assertScope(profileId, vacancyId) {
  if (!safeId(profileId) || !safeId(vacancyId)) throw new TypeError('safe profileId and vacancyId are required');
}

function assertCandidate(item) {
  if (!item || !safeId(item.candidateRef) || !nonempty(item.title)) throw new TypeError('safe candidateRef and title are required');
}

export function candidateViewFromState(state, vacancyId) {
  if (!safeId(vacancyId)) throw new TypeError('safe vacancyId is required');
  return Object.values(state.candidates).filter(item => item.wildcard || item.vacancyIds.includes(vacancyId)).map(item => ({
    candidateRef: item.candidateRef, title: item.title, source: item.source, foundAt: item.foundAt,
    review: clone(item.reviewsByVacancy[vacancyId] ?? { status: 'active', score: null })
  }));
}

export function createMemoryCandidateStateStore({ onStep = () => {} } = {}) {
  const states = new Map();
  return {
    read(profileId) { return clone(states.get(profileId) ?? emptyState(profileId)); },
    transact(profileId, fn) {
      const next = this.read(profileId);
      const result = fn(next, step => onStep(step, clone(next)));
      states.set(profileId, clone(next));
      return result;
    }
  };
}

export function createCandidateState({ store = createMemoryCandidateStateStore(), isVacancyOwned = () => false } = {}) {
  function assertOwned(profileId, vacancyId) {
    assertScope(profileId, vacancyId);
    if (!isVacancyOwned(profileId, vacancyId)) throw new Error('vacancy_not_owned');
  }
  function read(profileId, vacancyId) {
    assertOwned(profileId, vacancyId);
    const state = store.read(profileId);
    if (state.profileId !== profileId || state.stateVersion !== CANDIDATE_STATE_VERSION) throw new Error('candidate_state_version_or_owner_mismatch');
    return state;
  }

  return {
    // Same candidate identity can have different reviews in different vacancies.
    candidates(profileId, vacancyId) {
      const state = read(profileId, vacancyId);
      return candidateViewFromState(state, vacancyId);
    },
    latestSnapshot(profileId, vacancyId) {
      const snapshots = read(profileId, vacancyId).snapshotsByVacancy[vacancyId] ?? [];
      return snapshots.length ? clone(snapshots.at(-1)) : null;
    },
    seen(profileId, vacancyId) { return clone(read(profileId, vacancyId).seenByVacancy[vacancyId] ?? {}); },
    setReview({ profileId, vacancyId, candidateRef, status }) {
      assertOwned(profileId, vacancyId);
      if (!safeId(candidateRef) || !statuses.has(status)) throw new TypeError('invalid candidate review');
      return store.transact(profileId, state => {
        const item = state.candidates[candidateRef];
        if (!item || !(item.wildcard || item.vacancyIds.includes(vacancyId))) throw new Error('candidate_not_in_vacancy');
        const prior = item.reviewsByVacancy[vacancyId] ?? { status: 'active', score: null };
        item.reviewsByVacancy[vacancyId] = { ...prior, status };
        return clone(item.reviewsByVacancy[vacancyId]);
      });
    },
    queryRevision(profileId, vacancyId, criteriaRevision) {
      if (!nonempty(criteriaRevision)) throw new TypeError('criteriaRevision is required');
      const state = read(profileId, vacancyId);
      // Legacy getSearchExclusions treats every nonempty recruiter comment as
      // query feedback; the flag is retained for a future UI affordance only.
      const exclusions = Object.values(state.commentsByVacancy[vacancyId] ?? {}).map(comment => comment.text).filter(nonempty).sort();
      return hash({ criteriaRevision, exclusions });
    },
    saveComment({ profileId, vacancyId, candidateRef, text, excludeFromSearch, updatedAt }) {
      assertOwned(profileId, vacancyId);
      if (!safeId(candidateRef) || !nonempty(text) || !nonempty(updatedAt) || typeof excludeFromSearch !== 'boolean') throw new TypeError('invalid comment');
      return store.transact(profileId, state => {
        const candidate = state.candidates[candidateRef];
        if (!candidate || !(candidate.wildcard || candidate.vacancyIds.includes(vacancyId))) throw new Error('candidate_not_in_vacancy');
        bucket(state.commentsByVacancy, vacancyId)[candidateRef] = { text, excludeFromSearch, updatedAt };
        if (!state.queriesByVacancy[vacancyId]?.manual) delete state.queriesByVacancy[vacancyId];
      });
    },
    saveQueries({ profileId, vacancyId, criteriaRevision, queries, manual = false, generatedAt }) {
      assertOwned(profileId, vacancyId);
      if (!Array.isArray(queries) || queries.some(q => !nonempty(q)) || !nonempty(generatedAt)) throw new TypeError('invalid queries');
      const revision = this.queryRevision(profileId, vacancyId, criteriaRevision);
      store.transact(profileId, state => { state.queriesByVacancy[vacancyId] = { criteriaRevision, revision, queries: [...queries], manual, generatedAt }; });
      return revision;
    },
    queries(profileId, vacancyId, criteriaRevision) {
      const record = read(profileId, vacancyId).queriesByVacancy[vacancyId];
      if (!record) return null;
      return record.manual || record.revision === this.queryRevision(profileId, vacancyId, criteriaRevision) ? clone(record) : null;
    },
    recordSearch({ profileId, vacancyId, jobId, searchedAt, criteriaRevision, sourceRevision, candidates, totalCollected }) {
      assertOwned(profileId, vacancyId);
      if (!safeId(jobId) || ![searchedAt, criteriaRevision, sourceRevision].every(nonempty) || !Array.isArray(candidates) || !Number.isSafeInteger(totalCollected) || totalCollected < candidates.length) throw new TypeError('invalid completed search');
      const unique = new Set();
      for (const candidate of candidates) {
        assertCandidate(candidate);
        if (candidate.vacancyId !== vacancyId) throw new Error('candidate_vacancy_mismatch');
        if (candidate.score != null && (typeof candidate.score !== 'number' || !Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 10)) throw new TypeError('invalid candidate score');
        if (unique.has(candidate.candidateRef)) throw new TypeError('duplicate candidate in search');
        unique.add(candidate.candidateRef);
      }
      return store.transact(profileId, (state, step) => {
        if (state.profileId !== profileId) throw new Error('candidate_state_owner_mismatch');
        const prior = bucket(state.seenByVacancy, vacancyId);
        const newIds = candidates.filter(item => !prior[item.candidateRef]).map(item => item.candidateRef);
        for (const item of candidates) {
          const old = state.candidates[item.candidateRef];
          const reviewsByVacancy = { ...(old?.reviewsByVacancy ?? {}) };
          const priorReview = reviewsByVacancy[vacancyId] ?? {};
          reviewsByVacancy[vacancyId] = { status: priorReview.status ?? 'active', score: item.score ?? priorReview.score ?? null };
          state.candidates[item.candidateRef] = {
            candidateRef: item.candidateRef, title: item.title, source: old?.source === 'manual' ? 'manual' : 'search',
            foundAt: old?.foundAt ?? searchedAt, wildcard: false,
            vacancyIds: [...new Set([...(old?.vacancyIds ?? []), vacancyId])], reviewsByVacancy
          };
        }
        step('candidate_pool'); // A failed pool write must never mark an ID as seen.
        for (const id of unique) prior[id] ??= searchedAt;
        step('seen_ledger');
        const snapshot = { stateVersion: CANDIDATE_STATE_VERSION, profileId, vacancyId, jobId, searchedAt, criteriaRevision, sourceRevision,
          candidateRefs: [...unique], totalCollected, totalAfterFilter: candidates.length, newCount: newIds.length, newCandidateRefs: newIds };
        (state.snapshotsByVacancy[vacancyId] ??= []).push(snapshot);
        step('snapshot');
        return clone(snapshot);
      });
    },
    // Dry-run only: returns the converted state and a summary, never mutates store.
    planLegacyImport(profileId, legacy) {
      if (!safeId(profileId) || legacy?.synthetic !== true || legacy.profileId !== profileId) throw new Error('synthetic_profile_binding_required');
      if (Object.keys(legacy).some(key => !['synthetic', 'profileId', 'allCandidates', 'seenIds', 'snapshots', 'comments', 'queries'].includes(key))) throw new Error('unsafe_legacy_field');
      const state = emptyState(profileId);
      for (const [id, raw] of Object.entries(legacy.allCandidates ?? {})) {
        if (!/^candidate_demo_[0-9]{3}$/.test(id) || !raw || !/^Synthetic [a-zA-Z0-9 .-]{1,80}$/.test(raw.title) || !['search', 'manual'].includes(raw.source) || !isoUtc(raw.found_at)) throw new Error('unsafe_legacy_candidate');
        if (Object.keys(raw).some(key => !['title', 'source', 'found_at', 'vacancy_ids', 'vacancy_data'].includes(key))) throw new Error('unsafe_legacy_candidate_field');
        if (!Array.isArray(raw.vacancy_ids) || raw.vacancy_ids.some(v => !/^vac_demo_[0-9]{3}$/.test(v) || !isVacancyOwned(profileId, v))) throw new Error('unsafe_legacy_vacancy');
        const reviewsByVacancy = {};
        for (const [vacancyId, review] of Object.entries(raw.vacancy_data ?? {})) {
          if (!/^vac_demo_[0-9]{3}$/.test(vacancyId) || !raw.vacancy_ids.includes(vacancyId) || !statuses.has(review.status) || (review.score != null && (typeof review.score !== 'number' || review.score < 0 || review.score > 10)) || Object.keys(review).some(key => !['status', 'score'].includes(key))) throw new Error('unsafe_legacy_review');
          reviewsByVacancy[vacancyId] = { status: review.status, score: review.score ?? null };
        }
        state.candidates[id] = { candidateRef: id, title: raw.title, source: raw.source, foundAt: raw.found_at,
          wildcard: raw.vacancy_ids.length === 0, vacancyIds: [...new Set(raw.vacancy_ids)], reviewsByVacancy };
      }
      for (const [vacancyId, seen] of Object.entries(legacy.seenIds ?? {})) {
        if (!/^vac_demo_[0-9]{3}$/.test(vacancyId) || !isVacancyOwned(profileId, vacancyId)) throw new Error('unsafe_legacy_vacancy');
        state.seenByVacancy[vacancyId] = {};
        for (const [id, date] of Object.entries(seen)) {
          if (!state.candidates[id] || !(state.candidates[id].wildcard || state.candidates[id].vacancyIds.includes(vacancyId)) || !/^202[0-9]-[0-9]{2}-[0-9]{2}$/.test(date)) throw new Error('seen_without_candidate_pool');
          state.seenByVacancy[vacancyId][id] = date;
        }
      }
      for (const raw of legacy.snapshots ?? []) {
        const { vacancy_id: vacancyId, searched_at: searchedAt, candidate_ids: ids, job_id: jobId } = raw;
        if (!/^vac_demo_[0-9]{3}$/.test(vacancyId) || !isVacancyOwned(profileId, vacancyId) || !isoUtc(searchedAt) || !/^job_demo_[0-9]{3}$/.test(jobId) || Object.keys(raw).some(key => !['vacancy_id', 'searched_at', 'candidate_ids', 'job_id', 'total_collected', 'total_after_knockout'].includes(key)) || !Array.isArray(ids) || ids.some(id => !state.candidates[id] || !(state.candidates[id].wildcard || state.candidates[id].vacancyIds.includes(vacancyId))) || !Number.isSafeInteger(raw.total_collected) || !Number.isSafeInteger(raw.total_after_knockout) || raw.total_collected < raw.total_after_knockout || raw.total_after_knockout < ids.length) throw new Error('unsafe_legacy_snapshot');
        (state.snapshotsByVacancy[vacancyId] ??= []).push({ stateVersion: CANDIDATE_STATE_VERSION, profileId, vacancyId, jobId, searchedAt, candidateRefs: ids, totalCollected: raw.total_collected, totalAfterFilter: raw.total_after_knockout });
      }
      for (const [vacancyId, comments] of Object.entries(legacy.comments ?? {})) {
        if (!/^vac_demo_[0-9]{3}$/.test(vacancyId) || !isVacancyOwned(profileId, vacancyId)) throw new Error('unsafe_legacy_vacancy');
        state.commentsByVacancy[vacancyId] = {};
        for (const [id, comment] of Object.entries(comments)) {
          if (!state.candidates[id] || !(state.candidates[id].wildcard || state.candidates[id].vacancyIds.includes(vacancyId)) || !/^Synthetic [a-zA-Z0-9 .-]{1,80}$/.test(comment.text) || typeof comment.excludeFromSearch !== 'boolean' || !isoUtc(comment.updatedAt) || Object.keys(comment).some(key => !['text', 'excludeFromSearch', 'updatedAt'].includes(key))) throw new Error('unsafe_legacy_comment');
          state.commentsByVacancy[vacancyId][id] = clone(comment);
        }
      }
      for (const [vacancyId, record] of Object.entries(legacy.queries ?? {})) {
        if (!/^vac_demo_[0-9]{3}$/.test(vacancyId) || !isVacancyOwned(profileId, vacancyId) || !Array.isArray(record.queries) || record.queries.some(q => !/^Synthetic [a-zA-Z0-9 .-]{1,80}$/.test(q)) || typeof record.manual !== 'boolean' || !isoUtc(record.generated_at) || Object.keys(record).some(key => !['queries', 'manual', 'generated_at'].includes(key))) throw new Error('unsafe_legacy_queries');
        // Generated cache hashes cannot be trusted across implementations. Preserve
        // only recruiter-pinned queries; generated lists need a fresh revision.
        if (record.manual) state.queriesByVacancy[vacancyId] = { criteriaRevision: 'legacy-unverified', revision: 'legacy-unverified', queries: [...record.queries], manual: true, generatedAt: record.generated_at };
      }
      return { dryRun: true, state, summary: { candidates: Object.keys(state.candidates).length, seenBuckets: Object.keys(state.seenByVacancy).length, snapshots: Object.values(state.snapshotsByVacancy).reduce((n, list) => n + list.length, 0), manualQueries: Object.keys(state.queriesByVacancy).length } };
    }
  };
}
