import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteColdSearchScheduleRepository } from '../src/sqlite-cold-search-schedule-repository.js';
import { loadPrivateHostConfig } from '../src/r03-private-host-config.js';
import { createPrivateBaseSearchPlan, legacyQueryConfigHash } from '../src/r03-private-base-plan.js';
import { createFullDiscoveryCostPreflight } from '../src/r03-full-discovery-budget.js';
import { runPrivateFullDiscoveryRehearsal } from '../src/r03-private-full-discovery-rehearsal.js';
import { intervalPlan } from '../src/cold-search-schedules.js';

const profileId = 'invented_profile'; const vacancyId = 'invented_vacancy';
const key = 'a'.repeat(64);
const sealed = value => {
  const iv = Buffer.alloc(16, 3); const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([2]), iv, cipher.getAuthTag(), ciphertext]).toString('base64');
};
const ats = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
  vacancy_context: 'Вымышленный клиент', filters: { area: { id: '1' },
    min_experience_years: 0 }, required: [{ name: 'инженер', weight: 1 }], knockout: [] };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-full-rehearsal-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['contexts', 'proactive', 'tokens', 'secrets', 'stage'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const write = (dir, name, value) => writeFileSync(join(root, dir, name), value, { mode: 0o600 });
  const sourceDbPath = join(root, 'source.sqlite');
  const source = new Database(sourceDbPath);
  source.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES(\'unchanged\')');
  source.close(); chmodSync(sourceDbPath, 0o600);
  const stageDbPath = join(root, 'stage', 'candidate.sqlite');
  const schedules = new SqliteColdSearchScheduleRepository(stageDbPath);
  for (let i = 0; i < 11; i++) schedules.persistSchedule({
    scheduleId: `invented_schedule_${i}`, legacyJobId: `invented_job_${i}`,
    profileId, vacancyId, enabled: false, nextRunAt: '2099-01-01T00:00:00.000Z',
    leaseOwner: null, leaseUntil: null, blockedByUnknownOccurrenceId: `block_${i}`,
    migrationQuarantine: { reason: i < 8 ? 'legacy_outcome_unknown' : 'cutover_review_required' } });
  schedules.close();
  const hostConfigFile = join(root, 'host-config.json');
  writeFileSync(hostConfigFile, JSON.stringify({ version: 'r03-private-host-v1', dbPath: sourceDbPath,
    profiles: [{ profileId, vacancyIds: [vacancyId], contextDirectory: join(root, 'contexts'),
      proactiveDirectory: join(root, 'proactive'), tokenDirectory: join(root, 'tokens') }] }), { mode: 0o600 });
  const stageReceiptFile = join(root, 'stage', 'receipt.json');
  writeFileSync(stageReceiptFile, JSON.stringify({ version: 'r03-private-schedule-stage-v1',
    status: 'disposable_only', migrationId: 'invented_migration', sourceDbPath,
    stagedDbPath: stageDbPath, sourceArchiveSha256: 'a'.repeat(64),
    cronSha256: 'b'.repeat(64), imported: 11, unknownQuarantined: 8, enabled: 0 }), { mode: 0o600 });
  write('contexts', `ats_config:${vacancyId}.json`, JSON.stringify({ value: JSON.stringify(ats) }));
  write('proactive', `queries-${vacancyId}.json`, JSON.stringify({ vacancy_id: vacancyId,
    queries: ['вымышленный инженер', 'вымышленный конструктор'],
    config_hash: legacyQueryConfigHash(ats) }));
  write('tokens', 'hh', sealed({ access_token: 'invented_token' }));
  write('secrets', 'hh_encryption_key', key);
  write('secrets', 'hh_user_agent', 'invented-recruiting/1.0 (contact@example.test)');
  const host = loadPrivateHostConfig(hostConfigFile);
  const plan = await createPrivateBaseSearchPlan({ resolveProfileBinding: host.resolveProfileBinding,
    isVacancyOwned: host.isVacancyOwned })(profileId, vacancyId, { allowGeneration: false });
  const preflightReceiptFile = join(root, 'preflight.json');
  writeFileSync(preflightReceiptFile, JSON.stringify({ ...createFullDiscoveryCostPreflight(plan,
    plan.queryCache.queries.map(query => ({ queryHash: hash(query), found: 2, pagesAtOne: 2 })),
    '2026-10-06T09:00:00.000Z'),
  migrationId: 'invented_migration', sourceArchiveSha256: 'a'.repeat(64),
  cronSha256: 'b'.repeat(64), requests: 2, disposition: 'read_only_estimate' }), { mode: 0o600 });
  return { root, hostConfigFile, stageReceiptFile, preflightReceiptFile,
    secretsDirectory: join(root, 'secrets'), outputDirectory: join(root, 'full'),
    profileId, vacancyId, execute: true,
    clock: () => new Date('2026-10-06T09:00:00.000Z') };
}

const resume = id => ({ id, title: 'Вымышленный инженер', first_name: 'Вымышленное',
  last_name: 'Имя', area: { name: 'Вымышленная область' },
  total_experience: { months: 48 }, experience: [] });

test('all queries and pages produce one disposable discovery snapshot with pending ATS queue', async t => {
  const f = await fixture(t); let calls = 0;
  const result = await runPrivateFullDiscoveryRehearsal({ ...f, fetchImpl: async url => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('per_page'), '50');
    const code = parsed.searchParams.get('text').includes('конструктор') ? 'b' : 'a';
    const page = parsed.searchParams.get('page');
    return { status: 200, ok: true, json: async () => ({ pages: 2, found: 2,
      items: [resume(`invented${code}${page}`)] }) };
  } });
  assert.equal(calls, 4);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.providerRequests, 4);
  assert.equal(result.assessmentRequests, 0);
  assert.equal(result.candidateCount, 4);
  assert.equal(result.assessmentPendingCount, 4);
  assert.equal(result.disposableDiscoveryComplete, true);
  assert.equal(result.published, false);
  const source = new Database(join(f.root, 'source.sqlite'), { readonly: true });
  assert.equal(source.prepare('SELECT value FROM sentinel').get().value, 'unchanged');
  source.close();
  const stage = new Database(join(f.root, 'stage', 'candidate.sqlite'), { readonly: true });
  assert.equal(stage.prepare('SELECT COUNT(*) AS n FROM cold_search_occurrences').get().n, 0);
  stage.close();
  const copy = new Database(join(f.outputDirectory, 'candidate.sqlite'), { readonly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM cold_search_occurrences WHERE status='succeeded'").get().n, 1);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM r03_accepted_assessment_queue').get().n, 4);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM cold_search_schedules WHERE enabled=0').get().n, 12);
  copy.close();
  const replay = await runPrivateFullDiscoveryRehearsal({ ...f,
    fetchImpl: async () => { throw new Error('must not dispatch'); } });
  assert.equal(replay.providerRequests, 0);
  assert.equal(replay.disposableDiscoveryComplete, true);
  const receipt = JSON.parse(readFileSync(join(f.outputDirectory, 'receipt.json')));
  assert.equal(receipt.published, false);
  assert.equal(receipt.morningFreshness, 'latest_completed');
  assert.equal(receipt.morningFeedCount, receipt.candidateCount);
  assert.match(receipt.morningFeedRevision, /^[a-f0-9]{24}$/);
  const legacyReceipt = { ...receipt };
  delete legacyReceipt.morningFreshness;
  delete legacyReceipt.morningFeedRevision;
  delete legacyReceipt.morningFeedCount;
  writeFileSync(join(f.outputDirectory, 'receipt.json'), JSON.stringify(legacyReceipt) + '\n');
  const legacyReplay = await runPrivateFullDiscoveryRehearsal({ ...f,
    fetchImpl: async () => { throw new Error('legacy receipt replay dispatched HH'); } });
  assert.equal(legacyReplay.status, 'replayed');
  assert.equal(legacyReplay.providerRequests, 0);
  assert.equal(legacyReplay.disposableDiscoveryComplete, true);
});

test('later HH 429 is typed unknown with no full snapshot', async t => {
  const f = await fixture(t); let calls = 0;
  const result = await runPrivateFullDiscoveryRehearsal({ ...f, fetchImpl: async url => {
    calls++;
    if (new URL(url).searchParams.get('page') === '1') return { status: 429, ok: false,
      json: async () => ({}) };
    return { status: 200, ok: true, json: async () => ({ pages: 2, found: 2,
      items: [resume('inventedresume')] }) };
  } });
  assert.equal(calls, 2);
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.disposableDiscoveryComplete, false);
  assert.equal(result.published, false);
  const copy = new Database(join(f.outputDirectory, 'candidate.sqlite'), { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM real_hh_snapshot').get().n, 0);
  copy.close();
});

test('one reviewed imported daily slot runs at its natural due time and replays without HH', async t => {
  const f = await fixture(t);
  const stage = new SqliteColdSearchScheduleRepository(join(f.root, 'stage', 'candidate.sqlite'));
  const selected = stage.getSchedule('invented_schedule_8');
  stage.persistSchedule({ ...selected, plan: intervalPlan(24, vacancyId),
    timezone: 'Europe/Moscow', nextRunAt: '2026-10-06T09:00:00.000Z',
    migrationQuarantine: { reason: 'cutover_review_required', migrationId: 'invented_migration' } });
  stage.close();
  let calls = 0;
  const input = { ...f, naturalScheduleId: 'invented_schedule_8',
    expectedNaturalAt: '2026-10-06T09:00:00.000Z', fetchImpl: async url => {
      calls++;
      const code = new URL(url).searchParams.get('text').includes('конструктор') ? 'b' : 'a';
      const page = new URL(url).searchParams.get('page');
      return { status: 200, ok: true, json: async () => ({ pages: 2, found: 2,
        items: [resume(`invented${code}${page}`)] }) };
    } };
  const result = await runPrivateFullDiscoveryRehearsal(input);
  assert.equal(result.status, 'succeeded');
  assert.equal(calls, 4);
  const copy = new Database(join(f.outputDirectory, 'candidate.sqlite'), { readonly: true });
  const occurrence = copy.prepare('SELECT payload FROM cold_search_occurrences').all().map(row => JSON.parse(row.payload));
  assert.equal(occurrence.length, 1);
  assert.equal(occurrence[0].scheduleId, 'invented_schedule_8');
  assert.equal(occurrence[0].legacyJobId, 'invented_job_8');
  assert.equal(occurrence[0].scheduledAt, input.expectedNaturalAt);
  assert.equal(occurrence[0].coalescedMissedCount, 0);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM cold_search_schedules WHERE enabled=0').get().n, 11);
  copy.close();
  const receipt = JSON.parse(readFileSync(join(f.outputDirectory, 'receipt.json')));
  assert.equal(receipt.disposition, 'disposable_natural');
  assert.equal(receipt.morningFreshness, 'latest_completed');
  assert.equal(receipt.morningFeedCount, receipt.candidateCount);
  const replay = await runPrivateFullDiscoveryRehearsal({ ...input,
    fetchImpl: async () => { throw new Error('replay dispatched HH'); } });
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.providerRequests, 0);
});

test('unknown imported history cannot be selected for a natural cycle', async t => {
  const f = await fixture(t);
  await assert.rejects(runPrivateFullDiscoveryRehearsal({ ...f,
    naturalScheduleId: 'invented_schedule_0', expectedNaturalAt: '2099-01-01T00:00:00.000Z',
    fetchImpl: async () => { throw new Error('HH must not be called'); } }));
});
