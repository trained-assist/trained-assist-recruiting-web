import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runPrivateOneAtsCanary } from '../src/r03-private-one-ats-canary.js';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { SqliteRealHhCandidateState, REAL_HH_RESULT_VERSION } from '../src/sqlite-real-hh-candidate-state.js';
import { createPrivateBaseSearchPlan } from '../src/r03-private-base-plan.js';
import { mapHhResumeCandidate } from '../src/hh-resume-mapping.js';

const profileId = 'invented_profile'; const vacancyId = 'invented_vacancy';
const build = '28766e4f7e86d5aa39a85ed77d1d7b8bb5e6077c';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'one-ats-canary-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['context', 'proactive', 'tokens', 'secrets', 'accepted'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const hostDbPath = join(root, 'host.sqlite');
  const hostDb = new Database(hostDbPath); hostDb.close(); chmodSync(hostDbPath, 0o600);
  const hostConfigFile = join(root, 'host-config.json');
  writeFileSync(hostConfigFile, JSON.stringify({ version: 'r03-private-host-v1', dbPath: hostDbPath,
    profiles: [{ profileId, vacancyIds: [vacancyId], contextDirectory: join(root, 'context'),
      proactiveDirectory: join(root, 'proactive'), tokenDirectory: join(root, 'tokens') }] }),
  { mode: 0o600 });
  const ats = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
    vacancy_context: 'Вымышленная фабрика', filters: { area: 1, min_experience_years: 0 },
    required: [{ name: 'инженер', weight: 2 }], knockout: [] };
  writeFileSync(join(root, 'context', `ats_config:${vacancyId}.json`),
    JSON.stringify({ value: JSON.stringify(ats) }), { mode: 0o600 });
  writeFileSync(join(root, 'proactive', `queries-${vacancyId}.json`),
    JSON.stringify({ vacancy_id: vacancyId, queries: ['инженер'], manual: true,
      config_hash: 'manual' }), { mode: 0o600 });
  writeFileSync(join(root, 'secrets', 'ladder_token'), 'invented_token', { mode: 0o600 });
  const plan = await createPrivateBaseSearchPlan({ resolveProfileBinding: async () => ({ profileId,
    contextDirectory: join(root, 'context'), proactiveDirectory: join(root, 'proactive') }),
    isVacancyOwned: () => true })(profileId, vacancyId);
  const dbPath = join(root, 'accepted', 'candidate.sqlite');
  const schedules = new SqliteColdSearchScheduleRepository(dbPath);
  const candidates = new SqliteRealHhCandidateState({ filename: dbPath,
    isVacancyOwned: (p, v) => p === profileId && v === vacancyId });
  const candidate = mapHhResumeCandidate({ id: 'inventedresume', title: 'Вымышленный инженер',
    first_name: 'Вымышленное', last_name: 'Имя', area: { name: 'Вымышленный регион' },
    total_experience: { months: 48 }, experience: [] }, ats, vacancyId).candidate;
  const snapshot = candidates.recordCompletedSearch({ version: REAL_HH_RESULT_VERSION,
    profileId, vacancyId, jobId: 'invented_job', source: 'scheduled',
    searchedAt: '2026-10-06T09:00:00.000Z', criteriaRevision: plan.criteriaRevision,
    sourceRevision: 'source_invented', totalCollected: 1, candidates: [candidate] });
  const schedule = { scheduleId: 'invented_schedule', legacyJobId: 'invented_legacy_job',
    profileId, vacancyId, enabled: false, nextRunAt: '2099-01-01T00:00:00.000Z',
    leaseOwner: null, leaseUntil: null, blockedByUnknownOccurrenceId: null };
  schedules.persistSchedule(schedule);
  const occurrence = { occurrenceId: 'invented_occurrence', scheduleId: schedule.scheduleId,
    legacyJobId: schedule.legacyJobId, profileId, vacancyId,
    scheduledAt: snapshot.searchedAt, status: 'succeeded', jobId: snapshot.jobId,
    snapshot: { sourceRevision: snapshot.sourceRevision,
      resultRevision: snapshot.resultRevision, resultCount: snapshot.candidateCount } };
  schedules.writeOccurrence.run({ ...occurrence, leaseOwner: null, leaseUntil: null,
    payload: JSON.stringify(occurrence) });
  candidates.close(); schedules.close();
  const sourceReceiptFile = join(root, 'accepted', 'receipt.json');
  writeFileSync(sourceReceiptFile, JSON.stringify({ version: 'r03-private-full-discovery-rehearsal-v1',
    disposition: 'disposable_full', occurrenceStatus: 'succeeded',
    disposableDiscoveryComplete: true, published: false, assessmentRequests: 0,
    profileId, vacancyId, occurrenceId: occurrence.occurrenceId,
    jobId: snapshot.jobId, candidateCount: 1 }), { mode: 0o600 });
  return { hostConfigFile, sourceReceiptFile, secretsDirectory: join(root, 'secrets'),
    preflightFile: join(root, 'preflight.json'), outputDirectory: join(root, 'one'),
    clock: () => new Date('2026-10-06T10:00:00.000Z') };
}

function provider({ failReal = false, runtimeBuild = build,
  rungs = ['opencode-go/space-bunny-free', 'openrouter/example:free'] } = {}) {
  let invented = 0, real = 0;
  return { calls: () => ({ invented, real }), fetchImpl: async (url, init) => {
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, build: runtimeBuild }));
    if (url.endsWith('/v1/models')) {
      assert.equal(init.headers.Authorization, 'Bearer invented_token');
      return new Response(JSON.stringify({ data: [{ id: 'free', rungs }] }));
    }
    assert.equal(url, 'https://llm-ladder.trainedassist.store/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'free'); assert.equal(body.max_tokens, 600);
    if (body.messages[0].content.includes('Вымышленный специалист')) invented++;
    else real++;
    if (real && failReal) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: {
      content: '{"score":8,"knockout_failed":[]}' } }] }));
  } };
}

test('fresh free-ladder proof, one accepted real candidate, then replay without provider', async t => {
  const f = await fixture(t);
  const p = provider();
  assert.equal((await runPrivateOneAtsCanary({ ...f, mode: 'preflight',
    fetchImpl: p.fetchImpl })).status, 'ready');
  const result = await runPrivateOneAtsCanary({ ...f, mode: 'run', fetchImpl: p.fetchImpl });
  assert.equal(result.status, 'assessed');
  assert.deepEqual(p.calls(), { invented: 1, real: 1 });
  const copy = new Database(join(f.outputDirectory, 'candidate.sqlite'), { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM real_hh_assessment').get().n, 1);
  copy.close();
  const replay = await runPrivateOneAtsCanary({ ...f, mode: 'replay',
    clock: () => new Date('2026-10-07T10:00:00.000Z'),
    fetchImpl: async () => { throw new Error('replay fetched'); } });
  assert.equal(replay.providerRequests, 0);
  assert.equal(JSON.parse(readFileSync(join(f.outputDirectory, 'receipt.json'))).published, false);
});

test('changed build or paid rung blocks before any LLM request', async t => {
  for (const options of [{ runtimeBuild: 'changed' },
    { rungs: ['opencode-go/space-bunny-free', 'openrouter/paid-model'] }]) {
    const f = await fixture(t);
    const p = provider(options);
    await assert.rejects(runPrivateOneAtsCanary({ ...f, mode: 'preflight',
      fetchImpl: p.fetchImpl }));
    assert.deepEqual(p.calls(), { invented: 0, real: 0 });
  }
});

test('failed one-candidate provider call remains unknown and cannot rerun', async t => {
  const f = await fixture(t);
  const p = provider({ failReal: true });
  await runPrivateOneAtsCanary({ ...f, mode: 'preflight', fetchImpl: p.fetchImpl });
  const result = await runPrivateOneAtsCanary({ ...f, mode: 'run', fetchImpl: p.fetchImpl });
  assert.equal(result.status, 'outcome_unknown');
  assert.deepEqual(p.calls(), { invented: 1, real: 1 });
  await assert.rejects(runPrivateOneAtsCanary({ ...f, mode: 'run',
    fetchImpl: async () => { throw new Error('must not dispatch'); } }));
});
