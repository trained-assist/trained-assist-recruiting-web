import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { createR03HistoricalRead } from '../src/r03-historical-read.js';

const descriptor = JSON.parse(readFileSync(new URL('../contracts/r03-historical-results.offline-capability.json', import.meta.url)));
const outputSchema = JSON.parse(readFileSync(new URL(`../contracts/${descriptor.outputSchemaRef}`, import.meta.url)));
const validateOutput = new Ajv2020({ strict: true }).compile(outputSchema);

function fixture(t, scope = 'recruiting.candidateSearch') {
  const child = spawn(process.execPath, [new URL('./fixtures/r03-historical-mcp.mjs', import.meta.url).pathname], {
    env: { ...process.env, OFFLINE_MCP_PROFILE_ID: 'invented_profile', OFFLINE_MCP_SCOPE: scope },
    stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  let id = 0;
  const call = (method, params = {}) => new Promise(resolve => {
    const next = ++id;
    pending.set(next, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
  });
  call.notify = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  return call;
}

test('offline MCP validates and returns the same historical-only domain projection', async t => {
  const call = fixture(t);
  assert.equal((await call('initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion, '2024-11-05');
  call.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await call('tools/list');
  assert.equal(tools.result.tools[0].name, descriptor.name);
  assert.equal(descriptor.testOnly, true);
  assert.equal((await call('tools/call', { name: descriptor.name,
    arguments: { vacancyId: 'invented_vacancy', profileId: 'injected' } })).error.code, -32602);
  assert.equal((await call('tools/call', { name: descriptor.name,
    arguments: { vacancyId: 'invented_other' } })).error.code, -32012);
  const result = await call('tools/call', { name: descriptor.name,
    arguments: { vacancyId: 'invented_vacancy' } });
  assert.ok(validateOutput(result.result.structuredContent));
  assert.equal(result.result.structuredContent.status, 'historical_only');
  assert.equal('freshness' in result.result.structuredContent, false);
  assert.equal('newCount' in result.result.structuredContent, false);
  const selected = new Map([['invented_profile\0invented_vacancy', {
    searchedAt: '2026-01-02T07:00:00.000Z', historicalRevision: 'invented_revision',
    candidates: [{ id: 'invented_resume', title: 'Вымышленный инженер', first_name: 'Вымышленное',
      last_name: 'Имя', area: { name: 'Вымышленный регион' }, score: 8,
      hh_url: 'https://hh.ru/resume/invented_resume' }] }]]);
  const read = createR03HistoricalRead({ selected,
    isVacancyOwned: (profile, vacancy) => profile === 'invented_profile' && vacancy === 'invented_vacancy' });
  assert.deepEqual(result.result.structuredContent,
    read.read({ profileId: 'invented_profile', scopes: ['recruiting.candidateSearch'] }, 'invented_vacancy').value);
});

test('offline MCP rejects missing trusted scope', async t => {
  const call = fixture(t, 'none');
  await call('initialize', { protocolVersion: '2024-11-05' });
  call.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await call('tools/call', { name: descriptor.name,
    arguments: { vacancyId: 'invented_vacancy' } })).error.code, -32011);
});
