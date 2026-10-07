import { readFileSync } from 'node:fs';
import net from 'node:net';
import Ajv2020 from 'ajv/dist/2020.js';
import { mapHhResumeCandidate } from '../../src/hh-resume-mapping.js';
import { createRealProactiveRead } from '../../src/r03-real-proactive-read.js';

// Test-only JSON-RPC harness. No production listener or network egress.
globalThis.fetch = async () => { throw new Error('offline fixture blocks egress'); };
net.Socket.prototype.connect = () => { throw new Error('offline fixture blocks egress'); };
const load = name => JSON.parse(readFileSync(new URL(`../../contracts/${name}`, import.meta.url), 'utf8'));
const descriptor = load('r03-real-results.offline-capability.json');
const inputSchema = load(descriptor.inputSchemaRef);
const outputSchema = load(descriptor.outputSchemaRef);
const ajv = new Ajv2020({ strict: true });
const validateInput = ajv.compile(inputSchema);
const validateOutput = ajv.compile(outputSchema);
const profileId = process.env.OFFLINE_MCP_PROFILE_ID ?? '';
const vacancyId = 'vacancy_synthetic_real_001';
const ats = { filters: { min_experience_years: 0 }, required: [{ name: 'вымышленный критерий', weight: 1 }], knockout: [] };
const candidate = mapHhResumeCandidate({ id: 'syntheticresume1', title: 'Вымышленный инженер',
  first_name: 'Вымышленное', last_name: 'Имя', total_experience: { months: 24 },
  area: { name: 'Вымышленный регион' }, salary: null,
  experience: [{ position: 'Вымышленный инженер', company: 'Вымышленная компания', start: '2021-01-01', end: null }]
}, ats, vacancyId).candidate;
const item = { ...candidate, source: 'manual', jobId: 'job_synthetic_1', lastFoundAt: '2026-10-06T06:00:00.000Z',
  review: { status: 'active', revision: 0 }, comment: null, excludeFromSearch: false };
const feed = { read: () => ({ status: 'completed', freshness: 'latest_completed', total: 1,
  resultRevision: '1234567890abcdef12345678', items: [item] }) };
const read = createRealProactiveRead({ feed, resolveVacancyOwnership: (context, vacancy) => context.profileId === profileId && vacancy === vacancyId });
let lifecycle = 'new';
const reply = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const error = (id, code, message) => reply({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(request) {
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    if (lifecycle !== 'new') return error(id, -32600, 'already_initialized');
    if (params.protocolVersion !== '2024-11-05') return error(id, -32015, 'protocol_version_mismatch');
    lifecycle = 'awaiting_initialized';
    return reply({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'r03-real-results-offline', version: '1' } } });
  }
  if (method === 'notifications/initialized') { if (lifecycle === 'awaiting_initialized') lifecycle = 'ready'; return; }
  if (lifecycle !== 'ready') return error(id, -32016, 'initialization_required');
  if (method === 'tools/list') return reply({ jsonrpc: '2.0', id, result: { tools: [{
    name: descriptor.name, description: descriptor.description, inputSchema }] } });
  if (method !== 'tools/call' || params.name !== descriptor.name) return error(id, -32601, 'method_not_found');
  if (!profileId || process.env.OFFLINE_MCP_SCOPE !== 'recruiting.candidateSearch') return error(id, -32011, 'trusted_profile_scope_required');
  if (!validateInput(params.arguments ?? {})) return error(id, -32602, 'invalid_arguments');
  const outcome = await read({ profileId, scopes: ['recruiting.candidateSearch'] }, params.arguments.vacancyId);
  if (outcome.kind !== 'found') return error(id, -32012, 'not_found');
  if (!validateOutput(outcome.value)) return error(id, -32603, 'invalid_output');
  reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
    structuredContent: outcome.value, isError: false } });
}

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let request;
    try { request = JSON.parse(line); } catch { error(null, -32700, 'parse_error'); continue; }
    Promise.resolve(handle(request)).catch(() => error(request?.id ?? null, -32603, 'fixture_error'));
  }
});
