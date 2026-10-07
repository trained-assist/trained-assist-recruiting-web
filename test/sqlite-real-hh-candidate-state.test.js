import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { REAL_HH_RESULT_VERSION, SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';

const profileA = 'profile_synthetic_a';
const profileB = 'profile_synthetic_b';
const vacancyA = 'vacancy_synthetic_a';
const vacancyB = 'vacancy_synthetic_b';
const ats = { filters: { min_experience_years: 0 }, required: [{ name: 'проектирование машин', weight: 3 }], knockout: ['вымышленный стоп-фактор'] };
const owned = (profile, vacancy) => profile === profileA && [vacancyA, vacancyB].includes(vacancy) || profile === profileB && vacancy === vacancyB;
const candidate = (n, vacancyId = vacancyA) => mapHhResumeCandidate({
  id: `syntheticresume${String(n).padStart(4, '0')}`, title: n % 2 ? 'Инженер-конструктор' : 'Аналитик',
  first_name: `Вымышленное${n}`, last_name: 'Имя', total_experience: { months: 12 + n },
  area: { name: 'Вымышленный регион' }, salary: { amount: 100000 + n, currency: 'RUR' },
  experience: [{ position: n % 2 ? 'проектирование машин' : 'аналитика', company: 'Вымышленная компания', start: '2020-01-01', end: null }]
}, ats, vacancyId).candidate;
const run = (candidates, overrides = {}) => ({ version: REAL_HH_RESULT_VERSION, profileId: profileA, vacancyId: vacancyA,
  jobId: 'job_synthetic_001', searchedAt: '2026-10-06T06:00:00.000Z', criteriaRevision: 'criteria_synthetic_r1',
  sourceRevision: 'hh_resume_search_synthetic_r1', source: 'scheduled', totalCollected: candidates.length, candidates, ...overrides });

function fixture(t, onStep = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'real-hh-state-'));
  const filename = join(directory, 'private.sqlite');
  const stores = [];
  t.after(() => { for (const store of stores) if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { filename, open: options => {
    const store = new SqliteRealHhCandidateState({ filename, isVacancyOwned: owned, onStep, ...options });
    stores.push(store); return store;
  } };
}

test('versioned result accepts 257 invented candidates and deterministic pages across restart', t => {
  const schema = JSON.parse(readFileSync(new URL('../contracts/v1-real-hh-result.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const input = run(Array.from({ length: 257 }, (_, n) => candidate(n + 1)));
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  const { filename, open } = fixture(t);
  const first = open();
  const snapshot = first.recordCompletedSearch(input);
  assert.equal(snapshot.candidateCount, 257);
  assert.equal(snapshot.newCount, 257);
  assert.equal(first.seenTotal(profileA, vacancyA), 257);
  assert.equal(statSync(filename).mode & 0o077, 0);
  let cursor = null;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const page = first.resultPage({ profileId: profileA, vacancyId: vacancyA, jobId: input.jobId, cursor, limit: 100 });
    ids.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  }
  assert.equal(cursor, null);
  assert.equal(ids.length, 257);
  assert.equal(new Set(ids).size, 257);
  first.close();
  const second = open();
  assert.deepEqual(second.latestSnapshot(profileA, vacancyA), snapshot);
  assert.deepEqual(second.resultPage({ profileId: profileA, vacancyId: vacancyA, jobId: input.jobId, limit: 100 }).items.map(item => item.id), ids.slice(0, 100));
  assert.equal(second.recordCompletedSearch(input).newCount, 257, 'replay returns original snapshot without another seen mutation');
  assert.equal(second.seenTotal(profileA, vacancyA), 257);
});

test('two connections serialize writes, maintain profile/vacancy isolation, and keep prior snapshot immutable', t => {
  const { open } = fixture(t);
  const a = open();
  const b = open();
  const first = run([candidate(1), candidate(2)]);
  a.recordCompletedSearch(first);
  const second = run([candidate(1), candidate(3)], { jobId: 'job_synthetic_002', searchedAt: '2026-10-06T07:00:00.000Z' });
  b.recordCompletedSearch(second);
  assert.equal(a.seenTotal(profileA, vacancyA), 3);
  assert.equal(b.latestSnapshot(profileA, vacancyA).jobId, second.jobId);
  assert.equal(a.resultPage({ profileId: profileA, vacancyId: vacancyA, jobId: first.jobId }).items.length, 2);
  assert.equal(a.resultPage({ profileId: profileA, vacancyId: vacancyA, jobId: first.jobId }).items[0].firstName, candidate(1).firstName);
  assert.throws(() => a.resultPage({ profileId: profileB, vacancyId: vacancyA, jobId: first.jobId }), /real_hh_scope_denied/);
  assert.equal(a.latestSnapshot(profileB, vacancyB), null);
  assert.equal(b.resultPage({ profileId: profileB, vacancyId: vacancyB, jobId: first.jobId }), null);
  assert.throws(() => b.recordCompletedSearch(run([candidate(4)], { profileId: profileB })), /real_hh_scope_denied/);
});

test('failure before commit rolls back candidate, seen and snapshot together', t => {
  let fail = true;
  const { open } = fixture(t, step => { if (fail && step === 'snapshot') throw new Error('simulated_crash_before_commit'); });
  const store = open();
  const input = run(Array.from({ length: 251 }, (_, n) => candidate(n + 1)));
  assert.throws(() => store.recordCompletedSearch(input), /simulated_crash_before_commit/);
  assert.equal(store.latestSnapshot(profileA, vacancyA), null);
  assert.equal(store.seenTotal(profileA, vacancyA), 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM real_hh_candidate').get().count, 0);
  fail = false;
  assert.equal(store.recordCompletedSearch(input).candidateCount, 251);
});

test('invalid, duplicate or cross-vacancy IDs and raw response fields fail before write', t => {
  const { open } = fixture(t);
  const store = open();
  assert.throws(() => store.recordCompletedSearch(run([candidate(1), candidate(1)])), /duplicate_real_hh_resume_id/);
  assert.throws(() => store.recordCompletedSearch(run([{ ...candidate(1), id: '../bad' }])), /invalid_real_hh_candidate/);
  assert.throws(() => store.recordCompletedSearch(run([candidate(1, vacancyB)])), /invalid_real_hh_candidate/);
  assert.throws(() => store.recordCompletedSearch(run([{ ...candidate(1), rawResponse: { secret: 'synthetic' } }])), /invalid_real_hh_candidate/);
  assert.throws(() => store.recordCompletedSearch({ ...run([candidate(1)]), rawResponse: { secret: 'synthetic' } }), /invalid_real_hh_search/);
  assert.equal(store.latestSnapshot(profileA, vacancyA), null);
});
