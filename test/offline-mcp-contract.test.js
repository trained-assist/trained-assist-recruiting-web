import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = resolve(root, 'test/fixtures/recruiting-offline-mcp.mjs');
const loadJson = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));

async function startFixture({ profileId = 'profile_demo_001', scopes = ['recruiting.candidateSearch'], testHooks = true } = {}) {
  const proc = spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: {
      ...process.env,
      OFFLINE_MCP_PROFILE_ID: profileId,
      OFFLINE_MCP_SCOPES: scopes.join(','),
      ...(testHooks ? { OFFLINE_MCP_TEST: '1' } : {})
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const lines = createInterface({ input: proc.stdout, terminal: false });
  let seq = 0;
  const pending = new Map();
  const unsolicited = [];
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const item = pending.get(response.id);
    if (!item) { unsolicited.push(response); return; }
    pending.delete(response.id);
    clearTimeout(item.timer);
    item.resolve(response);
  });
  const stderr = [];
  proc.stderr.on('data', chunk => stderr.push(String(chunk)));
  proc.on('exit', code => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`offline MCP fixture exited ${code}: ${stderr.join('')}`)); }
    pending.clear();
  });
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 3000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const rawCall = (line, expectedId) => new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => { pending.delete(expectedId); reject(new Error('MCP raw response timeout')); }, 3000);
    pending.set(expectedId, { resolve: resolveCall, reject, timer });
    proc.stdin.write(`${line}\n`);
  });
  const notify = (method, params = {}) => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const stop = async () => {
    if (proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    await new Promise(resolveStop => proc.once('exit', resolveStop));
  };
  return { call, rawCall, notify, stop, proc, unsolicited };
}

async function initializeFixture(fixture, protocolVersion = '2024-11-05') {
  const response = await fixture.call('initialize', {
    protocolVersion,
    capabilities: { experimental: { relayContractVersion: 1 } },
    clientInfo: { name: 'offline-contract-test', version: '1' }
  });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  fixture.notify('notifications/initialized');
  return response;
}

function contentResult(response) {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.equal(response.result.isError, false);
  return response.result.structuredContent;
}

test('descriptor-driven local MCP round-trip invokes shared schedule handlers with fake clock and synthetic dependencies', async t => {
  const descriptor = await loadJson('contracts/recruiting-capabilities-v1.json');
  const relay = await loadJson('contracts/capability-relay-v1.compatibility.json');
  assert.equal(descriptor.relayContract.urn, relay.urn);
  assert.equal(descriptor.relayContract.versionRange, '>=1 <2');
  assert.equal(descriptor.relayContract.source.revision, relay.sourceRevision);
  assert.equal(descriptor.relayContract.source.protocolVersion, relay.protocolVersion);
  assert.equal(descriptor.relayContract.source.sha256, relay.sourceFileSha256);
  const serverSource = await readFile(resolve(root, 'src/server.js'), 'utf8');
  assert.doesNotMatch(serverSource.slice(serverSource.indexOf('const capabilities ='), serverSource.indexOf('const manifest =')), /cold_search|candidateSearch|profile/i, 'profile-scoped actions stay out of unauthenticated C14 discovery');
  const fixtureSource = await readFile(entrypoint, 'utf8');
  assert.match(fixtureSource, /OFFLINE_MCP_TEST/);
  assert.match(fixtureSource, /blocks socket egress/);
  assert.doesNotMatch(fixtureSource, /launchAgentRun|runAgent|codex\s+exec|claude\s+-p/i);
  for (const path of ['src/server.js', 'src/cold-search-schedules.js', 'src/candidate-search-jobs.js']) {
    const source = await readFile(resolve(root, path), 'utf8');
    assert.doesNotMatch(source, /launchAgentRun|runAgent|runMcpTool|spawnAgent|codex\s+exec|claude\s+-p/i, path);
    assert.doesNotMatch(source, /from\s+['"](?:child_process|@modelcontextprotocol\/sdk)/, path);
  }

  const fixture = await startFixture();
  t.after(fixture.stop);
  const preInit = await fixture.call('tools/list');
  assert.equal(preInit.error.message, 'initialization_required');
  const init = await initializeFixture(fixture, descriptor.relayContract.source.protocolVersion);
  assert.equal(init.error, undefined);
  assert.equal(init.result.capabilities.experimental.relayContract.version, 1);
  const listed = await fixture.call('tools/list');
  assert.equal(listed.error, undefined);
  assert.deepEqual(fixture.unsolicited, [], 'initialized notification has no JSON-RPC response');
  assert.equal(listed.result.tools.length, descriptor.capabilities.length);
  for (let i = 0; i < descriptor.capabilities.length; i++) {
    const capability = descriptor.capabilities[i];
    const schema = await loadJson(`contracts/${capability.inputSchemaRef}`);
    assert.deepEqual(listed.result.tools[i], { name: capability.name, description: capability.description, inputSchema: schema });
    assert.equal(typeof capability.operationRef, 'string');
  }

  const enabledResponse = await fixture.call('tools/call', { name: 'manage_cold_search_schedule', arguments: { action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 6 } });
  const enabled = contentResult(enabledResponse);
  assert.equal(enabled.kind, 'updated');
  assert.equal(enabled.schedule.profileId, 'profile_demo_001');
  const scheduleSchema = await loadJson('contracts/v1-cold-search-schedule.schema.json');
  const scheduleResultSchema = await loadJson('contracts/v1-cold-search-schedule-result.schema.json');
  const scheduleAjv = new Ajv2020({ allErrors: true });
  scheduleAjv.addSchema(scheduleSchema);
  const validateScheduleResult = scheduleAjv.compile(scheduleResultSchema);
  assert.equal(validateScheduleResult(enabled), true, JSON.stringify(validateScheduleResult.errors));
  const malformed = structuredClone(enabled);
  delete malformed.schedule.timezone;
  assert.equal(validateScheduleResult(malformed), false, 'missing required schedule fields fail output validation');
  const duplicate = contentResult(await fixture.call('tools/call', { name: 'manage_cold_search_schedule', arguments: { action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 6 } }));
  assert.equal(duplicate.schedule.scheduleId, enabled.schedule.scheduleId);
  assert.equal(contentResult(await fixture.call('tools/call', { name: 'manage_cold_search_schedule', arguments: { action: 'status' } })).schedules.length, 1);
  assert.equal((await fixture.call('testing/clock.set', { iso: enabled.schedule.nextRunAt })).result.now, enabled.schedule.nextRunAt);
  assert.deepEqual((await fixture.call('testing/schedule.tick')).result, { claimed: 1, completed: 1, unknown: 0 });
  const occurrenceResponse = contentResult(await fixture.call('tools/call', { name: 'list_cold_search_occurrences', arguments: { vacancyId: 'vac_demo_001' } }));
  assert.equal(occurrenceResponse.occurrences.length, 1);
  assert.equal(occurrenceResponse.occurrences[0].status, 'succeeded');
  assert.equal(occurrenceResponse.occurrences[0].snapshot.resultCount, 3);
  const occurrenceSchema = await loadJson('contracts/v1-cold-search-occurrence.schema.json');
  const outputSchema = await loadJson('contracts/v1-cold-search-occurrences.schema.json');
  const ajv = new Ajv2020({ allErrors: true });
  ajv.addSchema(occurrenceSchema);
  const validateOccurrence = ajv.compile(occurrenceSchema);
  const validateOutput = ajv.compile(outputSchema);
  assert.equal(validateOccurrence(occurrenceResponse.occurrences[0]), true, JSON.stringify(validateOccurrence.errors));
  assert.equal(validateOutput(occurrenceResponse), true, JSON.stringify(validateOutput.errors));
  const disabled = contentResult(await fixture.call('tools/call', { name: 'manage_cold_search_schedule', arguments: { action: 'disable', vacancyId: 'vac_demo_001' } }));
  assert.equal(disabled.schedule.enabled, false);
});

test('local MCP fixture fails closed for protocol/relay version, auth, schema, unknown tool and model-supplied profile', async t => {
  const fixture = await startFixture({ profileId: 'profile_demo_001' });
  t.after(fixture.stop);
  const badProtocol = await fixture.call('initialize', { protocolVersion: '2099-01-01', capabilities: { experimental: { relayContractVersion: 1 } } });
  assert.equal(badProtocol.error.data.code, 'version_mismatch');
  assert.equal((await fixture.rawCall('{broken-json', null)).error.code, -32700, 'transport parse errors are distinct from business errors');
  assert.equal((await fixture.rawCall('{"jsonrpc":"1.0","id":101,"method":"tools/list"}', 101)).error.code, -32600);
  const badRelay = await fixture.call('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { relayContractVersion: 2 } } });
  assert.equal(badRelay.error.data.code, 'version_mismatch');
  await initializeFixture(fixture);
  const invalid = await fixture.call('tools/call', { name: 'manage_cold_search_schedule', arguments: { action: 'enable', vacancyId: 'vac_demo_001', profileId: 'profile_demo_002' }, _meta: { authContext: { profileId: 'profile_demo_002' } } });
  assert.equal(invalid.error.data.code, 'invalid_arguments', 'profile fields are rejected, and caller _meta cannot override host-bound identity');
  assert.equal((await fixture.call('tools/call', { name: 'no_such_capability', arguments: {} })).error.data.code, 'not_found');

  const noAuth = await startFixture({ profileId: '', scopes: [] });
  t.after(noAuth.stop);
  await initializeFixture(noAuth);
  const authFailure = await noAuth.call('tools/call', { name: 'manage_cold_search_schedule', arguments: { action: 'status' } });
  assert.equal(authFailure.error.data.code, 'unauthorized');
  const insufficient = await startFixture({ profileId: 'profile_demo_001', scopes: ['recruiting.profile.read'] });
  t.after(insufficient.stop);
  await initializeFixture(insufficient);
  assert.equal((await insufficient.call('tools/call', { name: 'manage_cold_search_schedule', arguments: { action: 'status' } })).error.data.code, 'unauthorized');
});

test('unknown scheduler outcome stays quarantined across MCP calls and does not replay provider effects', async t => {
  const fixture = await startFixture();
  t.after(fixture.stop);
  await initializeFixture(fixture);
  const enabled = contentResult(await fixture.call('tools/call', { name: 'manage_cold_search_schedule', arguments: { action: 'enable', vacancyId: 'vac_demo_001', interval_hours: 6 } }));
  await fixture.call('testing/clock.set', { iso: enabled.schedule.nextRunAt });
  await fixture.call('testing/provider.setMode', { mode: 'unknown' });
  assert.deepEqual((await fixture.call('testing/schedule.tick')).result, { claimed: 1, completed: 0, unknown: 1 });
  const calls = (await fixture.call('testing/provider.stats')).result.calls;
  assert.equal((await fixture.call('testing/schedule.tick')).result.claimed, 0);
  assert.equal((await fixture.call('testing/provider.stats')).result.calls, calls);
  const occurrences = contentResult(await fixture.call('tools/call', { name: 'list_cold_search_occurrences', arguments: {} }));
  assert.equal(occurrences.occurrences[0].status, 'outcome_unknown');
});
