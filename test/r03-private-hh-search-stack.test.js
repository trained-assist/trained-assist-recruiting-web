import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';
import { R03LegacyScheduleImport } from '../src/r03-legacy-schedule-import.js';
import { R03LegacyScheduleActivation } from '../src/r03-legacy-schedule-activation.js';
import { createPrivateHhSearchStack } from '../src/r03-private-hh-search-stack.js';
import { createHhQueryGenerator } from '../src/r03-hh-query-generator.js';
import { createServiceLadderChat } from '../src/r03-service-ladder-chat.js';

const profileId = 'profile_invented_001';
const vacancyId = 'vacancy_invented_001';
const context = { profileId, scopes: ['recruiting.candidateSearch'] };
const key = 'a'.repeat(64);
const atsConfig = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
  vacancy_context: 'Вымышленная фабрика', filters: { area: 1, min_experience_years: 0 },
  required: [{ name: 'инженер', weight: 2 }], knockout: [] };
const resume = id => ({ id, title: 'Вымышленный инженер', first_name: 'Вымышленное', last_name: 'Имя',
  area: { name: 'Вымышленный регион' }, total_experience: { months: 48 },
  experience: [{ position: 'инженер', company: 'Вымышленное бюро' }] });
const goodReadiness = () => ({ profileBound: true, vacancyBound: true, atsReady: true,
  queryReady: true, hhCredentialVerified: true, candidateRestoreVerified: true,
  backgroundWriterReconciled: true });

test('imported schedule, private profile and credential produce a durable morning feed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'r03-private-stack-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const contextDirectory = join(directory, 'context');
  const proactiveDirectory = join(directory, 'proactive');
  const tokenDirectory = join(directory, 'tokens');
  for (const path of [contextDirectory, proactiveDirectory, tokenDirectory]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(contextDirectory, `ats_config:${vacancyId}.json`), JSON.stringify({ value: JSON.stringify(atsConfig) }));
  writeFileSync(join(tokenDirectory, 'hh'), JSON.stringify({ access_token: 'old_invented_access',
    refresh_token: 'invented_refresh' }), { mode: 0o600 });
  const filename = join(directory, 'private.sqlite');
  const repository = new SqliteColdSearchScheduleRepository(filename);
  const candidateState = new SqliteRealHhCandidateState({ filename,
    isVacancyOwned: (profile, vacancy) => profile === profileId && vacancy === vacancyId });
  t.after(() => { if (candidateState.db.open) candidateState.close(); if (repository.db.open) repository.close(); });
  const resolveProfileBinding = async profile => profile === profileId
    ? { profileId, contextDirectory, proactiveDirectory, tokenDirectory } : null;
  const isVacancyOwned = (profile, vacancy) => profile === profileId && vacancy === vacancyId;
  let now = '2026-10-06T00:00:00.000Z';
  const clock = () => new Date(now);
  let hhCalls = 0, oauthCalls = 0, queryCalls = 0;
  const fetchImpl = async (url, options) => {
    if (url === 'https://llm-ladder.trainedassist.store/v1/chat/completions') {
      queryCalls++;
      assert.equal(options.headers.Authorization, 'Bearer invented_service_token');
      return { ok: true, json: async () => ({ choices: [{ message: {
        content: '["Вымышленный инженер"]' } }] }) };
    }
    if (url === 'https://hh.ru/oauth/token') {
      oauthCalls++;
      return { ok: true, json: async () => ({ access_token: 'new_invented_access',
        refresh_token: 'next_invented_refresh' }) };
    }
    hhCalls++;
    if (options.headers.Authorization === 'Bearer old_invented_access')
      return { status: 401, ok: false, json: async () => ({}) };
    assert.equal(options.headers.Authorization, 'Bearer new_invented_access');
    const urlObject = new URL(url);
    assert.equal(urlObject.searchParams.get('text'), 'Вымышленный инженер');
    assert.deepEqual(urlObject.searchParams.getAll('area'), ['1']);
    const page = Number(urlObject.searchParams.get('page'));
    return { status: 200, ok: true, json: async () => ({
      items: Array.from({ length: 50 }, (_, n) => resume(`inventedpage${page}resume${n}`)),
      pages: 2, found: 100 }) };
  };
  const generateQueries = createHhQueryGenerator({ chat: createServiceLadderChat({
    loadToken: async () => 'invented_service_token', fetchImpl }) });
  const stack = createPrivateHhSearchStack({ resolveProfileBinding, isVacancyOwned,
    candidateState, scheduleRepository: repository, generateQueries,
    encryptionKey: key, clientId: 'invented_client', clientSecret: 'invented_secret', fetchImpl, clock });
  const imported = new R03LegacyScheduleImport({ repository, bindProfile: ref => ref === 'legacy_invented' ? profileId : null,
    isVacancyOwned, clock });
  assert.deepEqual(imported.import({ version: 'legacy-hh-schedules-v1', migrationId: 'migration_invented_001',
    definitions: [{ legacyJobId: 'legacy_invented_001', sourceProfileRef: 'legacy_invented', vacancyId,
      name: `cold-search:${vacancyId}`, action: 'hh_proactive_search', arguments: { vacancy_id: vacancyId },
      cron: '1 7 * * *', timezone: 'Europe/Moscow', enabled: false, lastStatus: 'success' }] }),
  { imported: 1, replayed: 0, quarantined: 1, unknown: 0 });
  const schedule = repository.listAllSchedules()[0];
  assert.equal((await stack.worker.tick('worker_before_activation')).claimed, 0);
  const activation = new R03LegacyScheduleActivation({ repository, authorizeOperator: () => true,
    checkReady: goodReadiness, clock });
  const activationResult = activation.activate({ scheduleId: schedule.scheduleId, legacyJobId: schedule.legacyJobId,
    migrationId: 'migration_invented_001', operatorId: 'operator_invented_001',
    definitionDigest: activation.imported.get(schedule.scheduleId).definition_digest,
    evidenceDigest: 'b'.repeat(64), unknownDisposition: 'not_applicable' });
  assert.equal(activationResult.kind, 'activated');
  assert.equal(hhCalls, 0);
  now = activationResult.receipt.nextRunAt;
  assert.deepEqual(await stack.worker.tick('worker_first'), { claimed: 1, completed: 1, rejected: 0, unknown: 0 });
  assert.equal(oauthCalls, 1);
  assert.equal(queryCalls, 1, 'missing legacy query cache is generated once in target SQLite');
  assert.equal(hhCalls, 3, 'one 401 and two successful result pages');
  const morning = stack.worker.morningResults(context, vacancyId);
  assert.equal(morning.freshness, 'latest_completed');
  assert.equal(morning.snapshot.candidateCount, 100);
  assert.equal(morning.items.length, 50);
  assert.equal(candidateState.seenTotal(profileId, vacancyId), 100);
  const secondPage = stack.worker.morningResults(context, vacancyId, { cursor: morning.nextCursor });
  assert.equal(secondPage.items.length, 50);
  assert.equal(new Set([...morning.items, ...secondPage.items].map(item => item.id)).size, 100);
  assert.equal((await stack.worker.tick('worker_repeat')).claimed, 0);
  assert.equal(hhCalls, 3);
  assert.equal(stack.worker.morningResults({ profileId: 'other_profile', scopes: context.scopes }, vacancyId).status, 'never_run');
});
