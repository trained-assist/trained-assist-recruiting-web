import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrivateLadderCanary } from '../src/r03-private-ladder-canary.js';
import { legacyQueryConfigHash } from '../src/r03-private-base-plan.js';

const profileId = 'invented_profile';
const vacancyId = 'invented_vacancy';
const ats = { vacancy_id: vacancyId, vacancy_title: 'Вымышленный инженер',
  vacancy_context: 'Вымышленная организация', filters: { area: { id: '1' } },
  required: [{ name: 'инженер', weight: 1 }], knockout: [] };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r03-ladder-canary-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['contexts', 'proactive', 'tokens', 'secrets'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const configFile = join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify({ version: 'r03-private-host-v1',
    dbPath: join(root, 'candidate.sqlite'), profiles: [{ profileId, vacancyIds: [vacancyId],
      contextDirectory: join(root, 'contexts'), proactiveDirectory: join(root, 'proactive'),
      tokenDirectory: join(root, 'tokens') }] }), { mode: 0o600 });
  const put = (dir, name, value) => writeFileSync(join(root, dir, name), value, { mode: 0o600 });
  put('contexts', `ats_config:${vacancyId}.json`, JSON.stringify({ value: JSON.stringify(ats) }));
  put('proactive', `queries-${vacancyId}.json`, JSON.stringify({ vacancy_id: vacancyId,
    queries: ['вымышленный инженер'], config_hash: legacyQueryConfigHash(ats) }));
  put('secrets', 'ladder_token', 'invented_ladder_token');
  return { configFile, secretsDirectory: join(root, 'secrets'), profileId, vacancyId, put };
}

test('owned canary makes exactly service and free calls using invented candidate only', async t => {
  const f = fixture(t); const calls = [];
  const result = await runPrivateLadderCanary({ ...f, execute: true, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: body.model === 'service'
      ? '["вымышленный инженер", "инженер проектировщик"]'
      : '{"score": 7, "knockout_failed": []}' } }] }) };
  } });
  assert.deepEqual(result, { status: 'ok', serviceQueryCount: 2, freeAssessmentAccepted: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => JSON.parse(call.init.body).model), ['service', 'free']);
  assert.deepEqual(calls.map(call => call.init.headers['x-ladder-app']), ['hh-proactive', 'hh-enrich']);
  assert.ok(calls.every(call => call.url === 'https://llm-ladder.trainedassist.store/v1/chat/completions'));
  assert.match(calls[1].init.body, /Вымышленный специалист/);
  assert.doesNotMatch(JSON.stringify(result), /invented_ladder_token|Вымышленный/);
});

test('unowned, absent token and stale query abort before provider calls', async t => {
  const f = fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected'); };
  await assert.rejects(runPrivateLadderCanary({ ...f, fetchImpl }), /private_ladder_canary_unavailable/);
  await assert.rejects(runPrivateLadderCanary({ ...f, vacancyId: 'other', execute: true, fetchImpl }),
    /private_ladder_canary_unavailable/);
  f.put('proactive', `queries-${vacancyId}.json`, JSON.stringify({ vacancy_id: vacancyId,
    queries: ['stale'], config_hash: 'stale' }));
  await assert.rejects(runPrivateLadderCanary({ ...f, execute: true, fetchImpl }),
    /private_search_plan_unavailable/);
  f.put('proactive', `queries-${vacancyId}.json`, JSON.stringify({ vacancy_id: vacancyId,
    queries: ['вымышленный инженер'], config_hash: legacyQueryConfigHash(ats) }));
  rmSync(join(f.secretsDirectory, 'ladder_token'));
  await assert.rejects(runPrivateLadderCanary({ ...f, execute: true, fetchImpl }),
    /private_host_config_unavailable/);
  assert.equal(calls, 0);
});
