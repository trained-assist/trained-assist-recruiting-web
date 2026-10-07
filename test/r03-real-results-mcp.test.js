import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const descriptor = JSON.parse(readFileSync(new URL('../contracts/r03-real-results.offline-capability.json', import.meta.url), 'utf8'));

function fixture(t, scope = 'recruiting.candidateSearch') {
  const child = spawn(process.execPath, [new URL('./fixtures/r03-real-results-mcp.mjs', import.meta.url).pathname], {
    env: { ...process.env, OFFLINE_MCP_PROFILE_ID: 'profile_synthetic_real_001', OFFLINE_MCP_SCOPE: scope },
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

test('offline MCP discovers and calls the same real candidate read with schema and trusted profile binding', async t => {
  const call = fixture(t);
  const initialized = await call('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.protocolVersion, '2024-11-05');
  call.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await call('tools/list');
  assert.equal(tools.result.tools[0].name, descriptor.name);
  assert.equal(descriptor.testOnly, true);
  const invalid = await call('tools/call', { name: descriptor.name,
    arguments: { vacancyId: 'vacancy_synthetic_real_001', profileId: 'model_supplied_profile' } });
  assert.equal(invalid.error.code, -32602);
  const deniedVacancy = await call('tools/call', { name: descriptor.name, arguments: { vacancyId: 'vacancy_other' } });
  assert.equal(deniedVacancy.error.code, -32012);
  const result = await call('tools/call', { name: descriptor.name,
    arguments: { vacancyId: 'vacancy_synthetic_real_001' } });
  assert.equal(result.result.structuredContent.total, 1);
  assert.equal(result.result.structuredContent.candidates[0].id, 'syntheticresume1');
  assert.deepEqual(JSON.parse(result.result.content[0].text), result.result.structuredContent);
});

test('offline MCP denies a caller without the search scope', async t => {
  const call = fixture(t, 'none');
  await call('initialize', { protocolVersion: '2024-11-05' });
  call.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const result = await call('tools/call', { name: descriptor.name,
    arguments: { vacancyId: 'vacancy_synthetic_real_001' } });
  assert.equal(result.error.code, -32011);
});
