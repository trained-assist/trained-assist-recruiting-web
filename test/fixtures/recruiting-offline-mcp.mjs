import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import net from 'node:net';
import Ajv2020 from 'ajv/dist/2020.js';
import { createRecruitingServer } from '../../src/server.js';
import { syntheticColdSearchProvider } from '../../src/candidate-search-jobs.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const descriptor = JSON.parse(await readFile(resolve(root, 'contracts/recruiting-capabilities-v1.json'), 'utf8'));
const relayCompatibility = JSON.parse(await readFile(resolve(root, 'contracts/capability-relay-v1.compatibility.json'), 'utf8'));
const schema = async ref => JSON.parse(await readFile(resolve(root, 'contracts', ref), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
ajv.addSchema(await schema('v1-cold-search-occurrence.schema.json'));
const descriptors = await Promise.all(descriptor.capabilities.map(async capability => {
  const inputSchema = await schema(capability.inputSchemaRef);
  const outputSchema = await schema(capability.outputSchemaRef);
  return { ...capability, inputSchema, validateInput: ajv.compile(inputSchema), validateOutput: ajv.compile(outputSchema) };
}));
const protocolVersion = relayCompatibility.protocolVersion;
const relayContractVersion = relayCompatibility.version;
let now = new Date(process.env.OFFLINE_MCP_CLOCK ?? '2026-10-06T00:00:00.000Z');
let providerMode = 'normal';
let providerCalls = 0;
const profileId = process.env.OFFLINE_MCP_PROFILE_ID ?? '';
const scopes = (process.env.OFFLINE_MCP_SCOPES ?? '').split(',').filter(Boolean);

// Guarded test-only process: schedule calls can use only this synthetic adapter.
// External network APIs are disabled; production service code has no MCP listener.
globalThis.fetch = async () => { throw new Error('offline MCP fixture blocks fetch egress'); };
net.Socket.prototype.connect = () => { throw new Error('offline MCP fixture blocks socket egress'); };
const server = createRecruitingServer({
  resolveTrustedProfileContext: () => profileId ? { profileId, scopes } : null,
  resolveCurrentSearchCriteriaRevision: () => 'criteria-search-demo-r1',
  resolveScheduledSearchRequest: async (_profileId, vacancyId) => ({
    vacancyId,
    criteriaRevision: 'criteria-search-demo-r1',
    criteria: { keywords: ['synthetic candidate'], regions: ['region_demo_001'] }
  }),
  scheduleClock: () => new Date(now),
  candidateSearchProvider: async input => {
    providerCalls++;
    if (providerMode === 'unknown') throw new Error('synthetic ambiguous provider outcome');
    return syntheticColdSearchProvider(input);
  }
});

const errorCodes = {
  unauthorized: -32011,
  not_found: -32012,
  invalid_arguments: -32013,
  version_mismatch: -32015,
  conflict: -32014
};
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function replyError(id, code, message) {
  const kind = Object.entries(errorCodes).find(([, number]) => number === code)?.[0] ?? 'internal';
  send({ jsonrpc: '2.0', id, error: { code, message, data: { code: kind } } });
}
async function handle(request) {
  const { id, method, params = {} } = request;
  if (request.jsonrpc !== '2.0' || typeof method !== 'string' || id === undefined || id === null) {
    replyError(id ?? null, -32600, 'invalid_json_rpc_request');
    return;
  }
  if (method === 'initialize') {
    const requestedRelayVersion = params.capabilities?.experimental?.relayContractVersion;
    if (params.protocolVersion !== protocolVersion || requestedRelayVersion !== undefined && requestedRelayVersion !== relayContractVersion) {
      replyError(id, errorCodes.version_mismatch, 'protocol_or_relay_contract_version_mismatch');
      return;
    }
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion,
      capabilities: { tools: {}, experimental: { relayContract: { urn: descriptor.relayContract.urn, version: relayContractVersion }, recruitingCapabilityContract: { urn: descriptor.urn, version: descriptor.version } } },
      serverInfo: { name: 'recruiting-offline-contract-fixture', version: String(descriptor.version) }
    } });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: descriptors.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    return;
  }
  if (method === 'tools/call') {
    const tool = descriptors.find(item => item.name === params.name);
    if (!tool) { replyError(id, errorCodes.not_found, 'unknown_recruiting_capability'); return; }
    if (!profileId || !scopes.includes('recruiting.candidateSearch')) { replyError(id, errorCodes.unauthorized, 'trusted_profile_scope_required'); return; }
    if (!tool.validateInput(params.arguments ?? {})) { replyError(id, errorCodes.invalid_arguments, 'arguments_do_not_match_capability_schema'); return; }
    const trustedContext = { profileId, scopes };
    const value = tool.name === 'manage_cold_search_schedule'
      ? await server.coldSearchSchedules.handle(params.arguments, trustedContext)
      : server.coldSearchSchedules.listOccurrences(trustedContext, params.arguments?.vacancyId);
    const error = value.kind === 'denied' ? 'unauthorized' : value.kind === 'invalid_command' || value.kind === 'invalid_vacancy' || value.kind === 'vacancy_required' ? 'invalid_arguments' : value.kind === 'not_found' ? 'not_found' : value.kind === 'outcome_unknown' ? 'conflict' : null;
    if (error) { replyError(id, errorCodes[error], error); return; }
    if (!tool.validateOutput(value)) throw new Error(`offline MCP output violates ${tool.outputSchemaRef}`);
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false } });
    return;
  }

  // Private deterministic hooks, deliberately unavailable as advertised tools.
  if (method === 'testing/clock.set') {
    const date = new Date(params.iso);
    if (!process.env.OFFLINE_MCP_TEST || !Number.isFinite(date.getTime())) { replyError(id, errorCodes.invalid_arguments, 'offline_test_hook_only'); return; }
    now = date;
    send({ jsonrpc: '2.0', id, result: { now: now.toISOString() } });
    return;
  }
  if (method === 'testing/provider.setMode') {
    if (!process.env.OFFLINE_MCP_TEST || !['normal', 'unknown'].includes(params.mode)) { replyError(id, errorCodes.invalid_arguments, 'offline_test_hook_only'); return; }
    providerMode = params.mode;
    send({ jsonrpc: '2.0', id, result: { mode: providerMode } });
    return;
  }
  if (method === 'testing/provider.stats') {
    if (!process.env.OFFLINE_MCP_TEST) { replyError(id, errorCodes.invalid_arguments, 'offline_test_hook_only'); return; }
    send({ jsonrpc: '2.0', id, result: { calls: providerCalls } });
    return;
  }
  if (method === 'testing/schedule.tick') {
    if (!process.env.OFFLINE_MCP_TEST) { replyError(id, errorCodes.invalid_arguments, 'offline_test_hook_only'); return; }
    const result = await server.coldSearchSchedules.tick('offline-test-worker');
    send({ jsonrpc: '2.0', id, result });
    return;
  }
  replyError(id, -32601, `method_not_found:${method}`);
}

process.stdin.setEncoding('utf8');
let buffered = '';
process.stdin.on('data', chunk => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf('\n');
    if (newline < 0) break;
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    let request;
    try { request = JSON.parse(line); }
    catch { replyError(null, -32700, 'json_parse_error'); continue; }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      replyError(null, -32600, 'invalid_json_rpc_request');
      continue;
    }
    Promise.resolve(handle(request)).catch(() => replyError(request.id, -32603, 'offline_fixture_internal_error'));
  }
});
