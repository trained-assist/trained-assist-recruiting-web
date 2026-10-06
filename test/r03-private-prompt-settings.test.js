import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecruitingServer } from '../src/server.js';
import { createPrivateBaseSearchPlan } from '../src/r03-private-base-plan.js';
import { createR03PrivatePromptSettings } from '../src/r03-private-prompt-settings.js';
import { SqlitePrivateBaseQueryCache } from '../src/sqlite-private-base-query-cache.js';
import { SqlitePrivateQueryOverrides } from '../src/sqlite-private-query-overrides.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';

const profileId = 'target_profile';
const vacancyId = 'target_vacancy';
const context = { profileId, scopes: ['recruiting.candidateSearch'] };

test('profile-bound prompt editor pins target queries, rejects stale writes and resets without touching frozen source', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'r03-private-prompt-'));
  const contextDirectory = join(directory, 'contexts');
  const proactiveDirectory = join(directory, 'proactive');
  mkdirSync(contextDirectory, { mode: 0o700 });
  mkdirSync(proactiveDirectory, { mode: 0o700 });
  const queryFile = join(proactiveDirectory, `queries-${vacancyId}.json`);
  const source = JSON.stringify({ vacancy_id: vacancyId, queries: ['старый закреплённый запрос'],
    manual: true, config_hash: 'manual' });
  writeFileSync(queryFile, source);
  writeFileSync(join(contextDirectory, `ats_config:${vacancyId}.json`), JSON.stringify({ value: JSON.stringify({
    vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
    vacancy_context: 'Вымышленная фабрика', filters: { area: 1, min_experience_years: 0 },
    required: [{ name: 'проектирование станков', weight: 3 }] }) }));
  const owned = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
  const state = new SqliteRealHhCandidateState({ filename: join(directory, 'target.sqlite'), isVacancyOwned: owned });
  t.after(() => { state.close(); rmSync(directory, { recursive: true, force: true }); });
  const overrides = new SqlitePrivateQueryOverrides({ db: state.db });
  let generated = 0;
  const loadBasePlan = createPrivateBaseSearchPlan({
    resolveProfileBinding: async profile => profile === profileId ? { profileId, contextDirectory, proactiveDirectory } : null,
    isVacancyOwned: owned, queryOverrides: overrides,
    queryCache: new SqlitePrivateBaseQueryCache({ db: state.db }),
    generateQueries: async () => { generated++; return [`новый запрос ${generated}`]; }
  });
  const prompt = createR03PrivatePromptSettings({ loadBasePlan, queryOverrides: overrides, isVacancyOwned: owned,
    clock: () => new Date('2026-10-06T10:00:00.000Z') });
  const server = createRecruitingServer({ realProactiveFeed: { read: () => ({ status: 'never_run',
    freshness: 'never_run', total: 0, resultRevision: 'invented', items: [] }) },
    realProactivePrompt: prompt, resolveRealVacancyOwnership: (trusted, vacancy) => owned(trusted.profileId, vacancy),
    resolveTrustedProfileContext: req => req.headers['x-test-principal'] ? {
      profileId: req.headers['x-test-principal'], scopes: ['recruiting.candidateSearch'] } : null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `/api/hh/proactive/prompt?vacancy_id=${vacancyId}`;
  const auth = { 'X-Test-Principal': profileId };
  const get = (path = endpoint, headers = auth) => fetch(base + path, { headers });
  const post = (body, headers = auth) => fetch(base + '/api/hh/proactive/prompt', { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await get()).status, 200);
  const initial = await (await get()).json();
  assert.deepEqual(initial.queries, ['старый закреплённый запрос']);
  assert.equal(initial.override_revision, 0);
  assert.equal((await get(endpoint, { 'X-Test-Principal': 'other_profile' })).status, 404);
  assert.equal((await get('/api/hh/proactive/prompt?vacancy_id=other_vacancy')).status, 404);
  assert.equal((await get('/api/hh/proactive/prompt?vacancy_id=other_vacancy&vacancy_id=other_vacancy')).status, 400);
  const command = { vacancy_id: vacancyId, queries: ' новый ручной запрос\nвторой запрос ',
    expected_revision: initial.query_revision, expected_override_revision: 0 };
  assert.equal((await post(command, { 'X-Test-Principal': 'other_profile' })).status, 404);
  const saved = await post(command);
  assert.equal(saved.status, 200);
  const manual = await saved.json();
  assert.deepEqual(manual.queries, ['новый ручной запрос', 'второй запрос']);
  assert.equal(manual.queries_manual, true);
  assert.equal(manual.override_revision, 1);
  assert.deepEqual((await loadBasePlan(profileId, vacancyId)).queryCache.queries, manual.queries);
  assert.equal(readFileSync(queryFile, 'utf8'), source);
  assert.equal((await post(command)).status, 409, 'stale editor cannot overwrite newer query revision');
  const invalid = { ...command, expected_revision: manual.query_revision,
    expected_override_revision: 1, queries: ['same', 'same'] };
  assert.equal((await post(invalid)).status, 400);
  const reset = await post({ ...command, queries: '', expected_revision: manual.query_revision,
    expected_override_revision: 1 });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).queries_state, 'reset');
  const regenerated = await (await get()).json();
  assert.deepEqual(regenerated.queries, ['новый запрос 1']);
  assert.equal(regenerated.queries_manual, false);
  assert.equal(regenerated.override_revision, 2);
  assert.equal(generated, 1);
  assert.equal(readFileSync(queryFile, 'utf8'), source);
  assert.equal(overrides.get(profileId, vacancyId).mode, 'reset');
});

for (const sourceMode of ['missing', 'stale']) {
  test(`GET and manual save never call ladder for ${sourceMode} source cache; explicit reset regenerates`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'r03-prompt-no-read-llm-'));
    const contexts = join(directory, 'contexts');
    const proactive = join(directory, 'proactive');
    mkdirSync(contexts, { mode: 0o700 });
    mkdirSync(proactive, { mode: 0o700 });
    writeFileSync(join(contexts, `ats_config:${vacancyId}.json`), JSON.stringify({ value: JSON.stringify({
      vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер', filters: { area: 1 },
      required: [{ name: 'проектирование станков', weight: 2 }] }) }));
    const queryFile = join(proactive, `queries-${vacancyId}.json`);
    const frozen = sourceMode === 'stale' ? JSON.stringify({ vacancy_id: vacancyId,
      queries: ['устаревший запрос'], config_hash: '0'.repeat(12) }) : null;
    if (frozen) writeFileSync(queryFile, frozen);
    const owned = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
    const state = new SqliteRealHhCandidateState({ filename: join(directory, 'target.sqlite'), isVacancyOwned: owned });
    t.after(() => { state.close(); rmSync(directory, { recursive: true, force: true }); });
    const overrides = new SqlitePrivateQueryOverrides({ db: state.db });
    let ladderCalls = 0;
    const loadBasePlan = createPrivateBaseSearchPlan({ isVacancyOwned: owned, queryOverrides: overrides,
      resolveProfileBinding: async profile => profile === profileId ?
        { profileId, contextDirectory: contexts, proactiveDirectory: proactive } : null,
      queryCache: new SqlitePrivateBaseQueryCache({ db: state.db }),
      generateQueries: async () => { ladderCalls++; return ['новый сгенерированный запрос']; } });
    const prompt = createR03PrivatePromptSettings({ loadBasePlan, queryOverrides: overrides,
      isVacancyOwned: owned });
    const initial = await prompt.read(context, vacancyId);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.queries, []);
    assert.equal(initial.body.pending_regeneration, true);
    assert.equal(ladderCalls, 0);
    const manual = await prompt.save(context, { vacancy_id: vacancyId, queries: 'ручной запрос',
      expected_revision: initial.body.query_revision, expected_override_revision: 0 });
    assert.equal(manual.status, 200);
    assert.equal(ladderCalls, 0);
    assert.deepEqual((await loadBasePlan(profileId, vacancyId)).queryCache.queries, ['ручной запрос']);
    assert.equal(ladderCalls, 0);
    const reset = await prompt.save(context, { vacancy_id: vacancyId, queries: '',
      expected_revision: manual.body.query_revision, expected_override_revision: 1 });
    assert.equal(reset.status, 200);
    assert.equal(ladderCalls, 1);
    assert.deepEqual(reset.body.queries, ['новый сгенерированный запрос']);
    const pinGenerated = await prompt.save(context, { vacancy_id: vacancyId,
      queries: 'новый сгенерированный запрос', expected_revision: reset.body.query_revision,
      expected_override_revision: 2 });
    assert.equal(pinGenerated.status, 200);
    assert.equal(pinGenerated.body.queries_manual, true,
      'explicit Save pins even unchanged generated text against later regeneration');
    assert.equal(pinGenerated.body.override_revision, 3);
    assert.equal(ladderCalls, 1);
    if (frozen) assert.equal(readFileSync(queryFile, 'utf8'), frozen);
    else assert.throws(() => readFileSync(queryFile), { code: 'ENOENT' });
  });
}
