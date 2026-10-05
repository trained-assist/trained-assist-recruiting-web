import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { candidateViewFromState, createCandidateState, createMemoryCandidateStateStore } from '../src/candidate-state.js';

const profileId = 'profile_demo_001';
const otherProfile = 'profile_demo_002';
const vacancyA = 'vac_demo_001';
const vacancyB = 'vac_demo_002';
const owned = (profile, vacancy) => profile === profileId && [vacancyA, vacancyB].includes(vacancy);
const createModel = options => createCandidateState({ isVacancyOwned: owned, ...options });
const candidate = (candidateRef, vacancyId, score = null) => ({ candidateRef, vacancyId, title: 'Synthetic engineer', score });
const search = (vacancyId, candidates, jobId = 'job_demo_001') => ({ profileId, vacancyId, jobId, searchedAt: '2026-10-06T06:00:00.000Z', criteriaRevision: 'criteria-r1', sourceRevision: 'provider-r1', candidates, totalCollected: candidates.length });

test('full candidate pool commits before seen IDs, and one profile cannot read another', () => {
  const steps = [];
  const store = createMemoryCandidateStateStore({ onStep(step, state) { steps.push(step); if (step === 'seen_ledger') {
    for (const id of Object.keys(state.seenByVacancy[vacancyA])) assert.ok(state.candidates[id]);
  } } });
  const model = createModel({ store });
  const pool = Array.from({ length: 40 }, (_, index) => candidate(`candidate_demo_${String(index + 1).padStart(3, '0')}`, vacancyA));
  const snapshot = model.recordSearch(search(vacancyA, pool));
  assert.deepEqual(steps, ['candidate_pool', 'seen_ledger', 'snapshot']);
  assert.equal(snapshot.newCount, 40);
  assert.equal(model.candidates(profileId, vacancyA).length, 40);
  assert.equal(Object.keys(model.seen(profileId, vacancyA)).length, 40);
  assert.throws(() => model.latestSnapshot(otherProfile, vacancyA), /vacancy_not_owned/);
  assert.throws(() => model.candidates(otherProfile, vacancyA), /vacancy_not_owned/);
  assert.equal(model.recordSearch(search(vacancyA, pool, 'job_demo_002')).newCount, 0);
});

test('runtime and dry-run states satisfy the versioned schema', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/v1-candidate-state.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const model = createModel();
  const runtime = createMemoryCandidateStateStore();
  const runtimeModel = createModel({ store: runtime });
  runtimeModel.recordSearch(search(vacancyA, [candidate('candidate_demo_001', vacancyA, 8)]));
  assert.equal(validate(runtime.read(profileId)), true, JSON.stringify(validate.errors));
  const golden = JSON.parse(await readFile(new URL('../data/r03-legacy-sanitized-golden.json', import.meta.url), 'utf8'));
  assert.equal(validate(model.planLegacyImport(profileId, golden).state), true, JSON.stringify(validate.errors));
});

test('candidate identity is shared; vacancy review and seen state remain separate', () => {
  const model = createModel();
  model.recordSearch(search(vacancyA, [candidate('candidate_demo_001', vacancyA, 8)]));
  const second = model.recordSearch(search(vacancyB, [candidate('candidate_demo_001', vacancyB, 3)], 'job_demo_002'));
  assert.equal(second.newCount, 1);
  model.setReview({ profileId, vacancyId: vacancyA, candidateRef: 'candidate_demo_001', status: 'starred' });
  assert.equal(model.candidates(profileId, vacancyA)[0].review.score, 8);
  assert.equal(model.candidates(profileId, vacancyA)[0].review.status, 'starred');
  assert.equal(model.candidates(profileId, vacancyB)[0].review.score, 3);
  assert.equal(model.candidates(profileId, vacancyB)[0].review.status, 'active');
  assert.equal(model.latestSnapshot(profileId, vacancyA).jobId, 'job_demo_001');
  assert.equal(model.latestSnapshot(profileId, vacancyB).jobId, 'job_demo_002');
});

test('failed pool step does not commit seen or freshness', () => {
  const store = createMemoryCandidateStateStore({ onStep(step) { if (step === 'candidate_pool') throw new Error('simulated store failure'); } });
  const model = createModel({ store });
  assert.throws(() => model.recordSearch(search(vacancyA, [candidate('candidate_demo_001', vacancyA)])), /simulated store failure/);
  assert.deepEqual(model.seen(profileId, vacancyA), {});
  assert.deepEqual(model.candidates(profileId, vacancyA), []);
  assert.equal(model.latestSnapshot(profileId, vacancyA), null);
});

test('failed snapshot commit leaves candidate and seen state unchanged', () => {
  const store = createMemoryCandidateStateStore({ onStep(step) { if (step === 'snapshot') throw new Error('simulated snapshot failure'); } });
  const model = createModel({ store });
  assert.throws(() => model.recordSearch(search(vacancyA, [candidate('candidate_demo_001', vacancyA)])), /simulated snapshot failure/);
  assert.deepEqual(store.read(profileId).candidates, {});
  assert.deepEqual(store.read(profileId).seenByVacancy, {});
  assert.deepEqual(store.read(profileId).snapshotsByVacancy, {});
});

test('comment exclusion changes query revision only in its vacancy and invalidates generated cache', () => {
  const model = createModel();
  model.recordSearch(search(vacancyA, [candidate('candidate_demo_001', vacancyA)]));
  model.recordSearch(search(vacancyB, [candidate('candidate_demo_001', vacancyB)], 'job_demo_002'));
  const beforeA = model.queryRevision(profileId, vacancyA, 'criteria-r1');
  const beforeB = model.queryRevision(profileId, vacancyB, 'criteria-r1');
  model.saveQueries({ profileId, vacancyId: vacancyA, criteriaRevision: 'criteria-r1', queries: ['Synthetic engineer'], generatedAt: '2026-10-06T06:00:00.000Z' });
  model.saveComment({ profileId, vacancyId: vacancyA, candidateRef: 'candidate_demo_001', text: 'Synthetic exclude region alpha', excludeFromSearch: true, updatedAt: '2026-10-06T07:00:00.000Z' });
  assert.notEqual(model.queryRevision(profileId, vacancyA, 'criteria-r1'), beforeA);
  assert.equal(model.queryRevision(profileId, vacancyB, 'criteria-r1'), beforeB);
  assert.equal(model.queries(profileId, vacancyA, 'criteria-r1'), null);
  model.saveQueries({ profileId, vacancyId: vacancyA, criteriaRevision: 'criteria-r1', queries: ['Synthetic pinned query'], manual: true, generatedAt: '2026-10-06T07:00:00.000Z' });
  model.saveComment({ profileId, vacancyId: vacancyA, candidateRef: 'candidate_demo_001', text: 'Synthetic exclude region beta', excludeFromSearch: true, updatedAt: '2026-10-06T08:00:00.000Z' });
  assert.deepEqual(model.queries(profileId, vacancyA, 'criteria-r1').queries, ['Synthetic pinned query']);
});

test('sanitized legacy conversion is dry-run, preserves multi-vacancy and wildcard, rejects unsafe fields', async () => {
  const legacy = JSON.parse(await readFile(new URL('../data/r03-legacy-sanitized-golden.json', import.meta.url), 'utf8'));
  const store = createMemoryCandidateStateStore();
  const model = createModel({ store });
  const plan = model.planLegacyImport(profileId, legacy);
  assert.deepEqual(plan.summary, { candidates: 2, seenBuckets: 2, snapshots: 2, manualQueries: 1 });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.state.candidates.candidate_demo_002.wildcard, true);
  assert.ok(candidateViewFromState(plan.state, vacancyA).some(item => item.candidateRef === 'candidate_demo_002'));
  assert.ok(candidateViewFromState(plan.state, vacancyB).some(item => item.candidateRef === 'candidate_demo_002'));
  assert.deepEqual(plan.state.candidates.candidate_demo_001.reviewsByVacancy, { vac_demo_001: { status: 'starred', score: 8 }, vac_demo_002: { status: 'archived', score: 3 } });
  assert.equal(plan.state.snapshotsByVacancy[vacancyA][0].totalCollected, 3);
  assert.deepEqual(plan.state.queriesByVacancy[vacancyA].queries, ['Synthetic backend specialist']);
  assert.equal(plan.state.queriesByVacancy[vacancyB], undefined);
  assert.equal(store.read(profileId).candidates.candidate_demo_001, undefined);
  assert.throws(() => model.planLegacyImport(otherProfile, legacy), /synthetic_profile_binding_required/);
  const pii = structuredClone(legacy);
  pii.allCandidates.candidate_demo_001.first_name = 'Real Name';
  assert.throws(() => model.planLegacyImport(profileId, pii), /unsafe_legacy_candidate_field/);
  const missing = structuredClone(legacy);
  delete missing.allCandidates.candidate_demo_001;
  assert.throws(() => model.planLegacyImport(profileId, missing), /seen_without_candidate_pool/);
  const wrongVacancy = createCandidateState({ isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyA });
  assert.throws(() => wrongVacancy.planLegacyImport(profileId, legacy), /unsafe_legacy_vacancy/);
  const badComment = structuredClone(legacy);
  badComment.comments[vacancyA].candidate_demo_001.updatedAt = 'not a timestamp';
  assert.throws(() => model.planLegacyImport(profileId, badComment), /unsafe_legacy_comment/);
  const badQuery = structuredClone(legacy);
  badQuery.queries[vacancyA].generated_at = 'Synthetic contact@example.com';
  assert.throws(() => model.planLegacyImport(profileId, badQuery), /unsafe_legacy_queries/);
  const serialized = JSON.stringify(legacy);
  assert.doesNotMatch(serialized, /(?:@|https?:\/\/|first_name|last_name|phone|token|[+]7\d{10})/i);
});

test('runtime rejects dangerous object keys and a candidate from another vacancy', () => {
  const model = createModel();
  assert.throws(() => model.recordSearch(search(vacancyA, [candidate('__proto__', vacancyA)])), /safe candidateRef/);
  assert.throws(() => model.recordSearch(search(vacancyA, [candidate('candidate_demo_001', vacancyB)])), /candidate_vacancy_mismatch/);
  assert.throws(() => model.recordSearch(search(vacancyA, [candidate('candidate_demo_001', vacancyA, 11)])), /invalid candidate score/);
  assert.throws(() => model.candidates(profileId, '__proto__'), /safe profileId and vacancyId/);
  assert.equal(Object.prototype.polluted, undefined);
});
