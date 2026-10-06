import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateBaseSearchPlan } from '../src/r03-private-base-plan.js';
import { SqlitePrivateBaseQueryCache } from '../src/sqlite-private-base-query-cache.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';

const profileId = 'profile_invented_001';
const vacancyId = 'vacancy_invented_001';
const config = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
  vacancy_context: 'Вымышленная фабрика', filters: { area: 1, min_experience_years: 0 },
  required: [{ name: 'проектирование станков', weight: 3 }] };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'r03-base-query-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contextDirectory = join(root, 'context');
  const proactiveDirectory = join(root, 'proactive');
  mkdirSync(contextDirectory, { mode: 0o700 });
  mkdirSync(proactiveDirectory, { mode: 0o700 });
  const contextFile = join(contextDirectory, `ats_config:${vacancyId}.json`);
  const queryFile = join(proactiveDirectory, `queries-${vacancyId}.json`);
  writeFileSync(contextFile, JSON.stringify({ value: JSON.stringify(config) }));
  const filename = join(root, 'private.sqlite');
  const state = new SqliteRealHhCandidateState({ filename,
    isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId });
  t.after(() => { if (state.db.open) state.close(); });
  const queryCache = new SqlitePrivateBaseQueryCache({ db: state.db });
  const resolveProfileBinding = async profile => profile === profileId
    ? { profileId, contextDirectory, proactiveDirectory } : null;
  const isVacancyOwned = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
  return { root, filename, state, queryCache, contextFile, queryFile,
    resolveProfileBinding, isVacancyOwned };
}

test('missing source cache regenerates once into target SQLite and survives restart', async t => {
  const f = fixture(t);
  let generated = 0;
  const load = createPrivateBaseSearchPlan({ resolveProfileBinding: f.resolveProfileBinding,
    isVacancyOwned: f.isVacancyOwned, queryCache: f.queryCache,
    generateQueries: async () => { generated++; return ['Вымышленный инженер']; } });
  const first = await load(profileId, vacancyId);
  assert.deepEqual(first.queryCache.queries, ['Вымышленный инженер']);
  assert.equal(generated, 1);
  assert.deepEqual(await load(profileId, vacancyId), first);
  assert.equal(generated, 1);
  assert.throws(() => readFileSync(f.queryFile), { code: 'ENOENT' }, 'frozen source is not rewritten');
  f.state.close();
  const reopened = new SqliteRealHhCandidateState({ filename: f.filename,
    isVacancyOwned: f.isVacancyOwned });
  t.after(() => { if (reopened.db.open) reopened.close(); });
  const afterRestart = createPrivateBaseSearchPlan({ resolveProfileBinding: f.resolveProfileBinding,
    isVacancyOwned: f.isVacancyOwned, queryCache: new SqlitePrivateBaseQueryCache({ db: reopened.db }),
    generateQueries: async () => { throw new Error('should use durable cache'); } });
  assert.deepEqual(await afterRestart(profileId, vacancyId), first);
});

test('stale generated source cache and changed ATS/comments create new target revisions', async t => {
  const f = fixture(t);
  const original = JSON.stringify({ vacancy_id: vacancyId, queries: ['старый запрос'], config_hash: '0'.repeat(12) });
  writeFileSync(f.queryFile, original);
  let calls = 0;
  const load = createPrivateBaseSearchPlan({ resolveProfileBinding: f.resolveProfileBinding,
    isVacancyOwned: f.isVacancyOwned, queryCache: f.queryCache,
    generateQueries: async ({ comments }) => { calls++; return [`Вымышленный инженер ${calls}`, ...comments.map(() => 'проектирование станков')]; } });
  const first = await load(profileId, vacancyId);
  assert.equal(calls, 1);
  assert.equal(readFileSync(f.queryFile, 'utf8'), original);
  writeFileSync(f.contextFile, JSON.stringify({ value: JSON.stringify({ ...config,
    required: [{ name: 'промышленные станки', weight: 4 }] }) }));
  const second = await load(profileId, vacancyId);
  assert.equal(calls, 2);
  assert.notEqual(second.queryCache.revision, first.queryCache.revision);
  writeFileSync(join(f.root, 'proactive', `candidate-comments-${vacancyId}.json`),
    JSON.stringify({ inventedresume: { text: 'Не подходит только административный опыт' } }));
  const third = await load(profileId, vacancyId);
  assert.equal(calls, 3);
  assert.notEqual(third.queryCache.revision, second.queryCache.revision);
  assert.equal(f.state.db.prepare('SELECT COUNT(*) AS n FROM r03_private_base_query_cache').get().n, 3);
});

test('manual queries stay pinned; bad source, bad generation and cross-profile access fail closed', async t => {
  const f = fixture(t);
  const load = createPrivateBaseSearchPlan({ resolveProfileBinding: f.resolveProfileBinding,
    isVacancyOwned: f.isVacancyOwned, queryCache: f.queryCache,
    generateQueries: async () => ['same', 'same'] });
  writeFileSync(f.queryFile, JSON.stringify({ vacancy_id: vacancyId,
    queries: ['закреплённый запрос'], manual: true, config_hash: 'stale' }));
  assert.deepEqual((await load(profileId, vacancyId)).queryCache.queries, ['закреплённый запрос']);
  assert.equal(f.state.db.prepare('SELECT COUNT(*) AS n FROM r03_private_base_query_cache').get().n, 0);
  writeFileSync(f.queryFile, '{');
  await assert.rejects(load(profileId, vacancyId), /private_search_plan_unavailable/);
  rmSync(f.queryFile);
  await assert.rejects(load(profileId, vacancyId), /private_search_plan_unavailable/);
  await assert.rejects(load('other_profile', vacancyId), /private_search_plan_unavailable/);
  assert.throws(() => createPrivateBaseSearchPlan({ resolveProfileBinding: f.resolveProfileBinding,
    isVacancyOwned: f.isVacancyOwned, generateQueries: async () => [] }),
  /private query regeneration ports required together/);
});
