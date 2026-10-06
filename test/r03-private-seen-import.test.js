import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecruitingServer } from '../src/server.js';
import { createR03PrivateSeenImport } from '../src/r03-private-seen-import.js';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';
import { REAL_HH_RESULT_VERSION, SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';

const profileId = 'target_profile';
const vacancyId = 'target_vacancy';
const otherVacancy = 'other_vacancy';
const otherProfile = 'other_profile';
const owned = (profile, vacancy) => [profileId, otherProfile].includes(profile) &&
  [vacancyId, otherVacancy].includes(vacancy);
const time = '2026-10-06T10:00:00.000Z';
const candidate = (id, vacancy) => mapHhResumeCandidate({ id, title: 'Вымышленный инженер',
  first_name: 'Вымышленное', last_name: 'Имя', total_experience: { months: 12 },
  area: { name: 'Вымышленная область' }, salary: null,
  experience: [{ position: 'Инженер', company: 'Вымышленная фабрика', start: '2021-01-01', end: null }]
}, { filters: { min_experience_years: 0 }, required: [], knockout: [] }, vacancy).candidate;

test('seen import is atomic, idempotent and scoped; next snapshot counts only unseen resumes as new', t => {
  const directory = mkdtempSync(join(tmpdir(), 'r03-seen-import-'));
  let failImport = false;
  const state = new SqliteRealHhCandidateState({ filename: join(directory, 'target.sqlite'),
    isVacancyOwned: owned, onStep: step => { if (step === 'import_seen' && failImport) {
      failImport = false; throw new Error('invented_transaction_failure');
    } } });
  t.after(() => { state.close(); rmSync(directory, { recursive: true, force: true }); });
  const importSeen = createR03PrivateSeenImport({ candidateState: state, isVacancyOwned: owned,
    clock: () => new Date(time) });
  const context = { profileId, scopes: ['recruiting.candidateSearch'] };
  const command = { vacancy_id: vacancyId, ids: ['resumeA1', 'resumeA1', 'resumeB2'] };
  assert.deepEqual(importSeen(context, command).body, { ok: true, vacancy_id: vacancyId, imported: 2, total: 2 });
  assert.deepEqual(importSeen(context, command).body, { ok: true, vacancy_id: vacancyId, imported: 0, total: 2 });
  assert.equal(state.seenTotal(profileId, otherVacancy), 0);
  assert.equal(state.seenTotal(otherProfile, vacancyId), 0);
  assert.equal(importSeen({ profileId: 'not_bound', scopes: context.scopes }, command).status, 404);
  assert.equal(importSeen({ profileId, scopes: [] }, command).status, 404);
  assert.equal(importSeen(context, { vacancy_id: 'unknown', ids: ['resumeX'] }).status, 404);
  assert.equal(importSeen(context, { vacancy_id: vacancyId, ids: ['validA', '../bad'] }).status, 400);
  assert.equal(state.seenTotal(profileId, vacancyId), 2, 'bad batch cannot partially write');
  failImport = true;
  assert.equal(importSeen(context, { vacancy_id: vacancyId, ids: ['resumeC3'] }).status, 503);
  assert.equal(state.seenTotal(profileId, vacancyId), 2, 'transaction failure rolls back every ID');
  const snapshot = state.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION,
    profileId, vacancyId, jobId: 'invented_job_1', searchedAt: time,
    criteriaRevision: 'invented_criteria', sourceRevision: 'invented_source',
    source: 'scheduled', totalCollected: 2,
    candidates: [candidate('resumeA1', vacancyId), candidate('resumeC3', vacancyId)] });
  assert.equal(snapshot.newCount, 1, 'imported seen ID is not counted new');
  assert.equal(state.seenTotal(profileId, vacancyId), 3);
});

test('real HTTP import-seen requires explicit vacancy and trusted profile, never guesses active vacancy', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'r03-seen-http-'));
  const state = new SqliteRealHhCandidateState({ filename: join(directory, 'target.sqlite'), isVacancyOwned: owned });
  const seenImport = createR03PrivateSeenImport({ candidateState: state, isVacancyOwned: owned,
    clock: () => new Date(time) });
  const server = createRecruitingServer({ realProactiveFeed: { read: () => ({ status: 'never_run',
    freshness: 'never_run', total: 0, resultRevision: 'invented', items: [] }) },
    realProactiveSeenImport: seenImport,
    resolveRealVacancyOwnership: (context, vacancy) => owned(context.profileId, vacancy),
    resolveTrustedProfileContext: req => req.headers['x-test-principal'] ?
      { profileId: req.headers['x-test-principal'], scopes: ['recruiting.candidateSearch'] } : null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); state.close();
    rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = '/api/hh/proactive/import-seen';
  const post = (body, principal = profileId) => fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(principal ? { 'X-Test-Principal': principal } : {}) },
    body: JSON.stringify(body) });
  assert.equal((await post({ vacancy_id: vacancyId, ids: ['invented1'] }, null)).status, 401);
  assert.equal((await post({ ids: ['invented1'] })).status, 400);
  assert.equal((await post({ vacancy_id: vacancyId, ids: ['invented1'] }, 'not_bound')).status, 404);
  assert.equal((await post({ vacancy_id: vacancyId, ids: ['invented1'] })).status, 200);
  const replay = await post({ vacancy_id: vacancyId, ids: ['invented1'] });
  assert.equal((await replay.json()).imported, 0);
  assert.equal((await fetch(base + path, { headers: { 'X-Test-Principal': profileId } })).status, 405);
  assert.equal(state.seenTotal(profileId, vacancyId), 1);
});
