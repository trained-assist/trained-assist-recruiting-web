#!/usr/bin/env node
// Agent Runner per-run stdio MCP facade for the public synthetic Recruiting sandbox probe.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const descriptor = JSON.parse(readFileSync(new URL('../../contracts/recruiting-capabilities-v1.json', import.meta.url), 'utf8'));
const relay = JSON.parse(readFileSync(new URL('../../contracts/capability-relay-v1.compatibility.json', import.meta.url), 'utf8'));
const serverId = 'recruiting-web-public-sandbox';
const allowedTools = new Set((process.env.MCP_ALLOWED_TOOLS ?? '').split(',').filter(Boolean));
const runnerRoot = process.env.AI_AGENT_RUNNER_ROOT;
if (!runnerRoot) throw new Error('AI_AGENT_RUNNER_ROOT is required by the public sandbox MCP facade');
const { BridgeClient } = await import(pathToFileURL(join(runnerRoot, 'src/mcp/fixtures/bridge-client.mjs')).href);
const bridge = new BridgeClient({ url: process.env.MCP_BRIDGE_URL ?? '', runToken: process.env.MCP_BRIDGE_TOKEN ?? '', serverId });
await bridge.open();

const schemaFor = ref => JSON.parse(readFileSync(new URL(`../../contracts/${ref}`, import.meta.url), 'utf8'));
const tools = descriptor.capabilities.map(capability => ({
  name: capability.toolId,
  description: capability.description,
  inputSchema: schemaFor(capability.inputSchemaRef),
  _meta: { capabilityId: capability.toolId, capabilityVersion: descriptor.version }
}));
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const toolResult = outcome => ({ content: [{ type: 'text', text: JSON.stringify({ outcome }) }],
  structuredContent: { outcome }, ...(outcome.kind === 'completed' ? {} : { isError: true }) });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end = buffer.indexOf('\n');
  while (end >= 0) {
    const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
    if (line.trim()) void handle(line);
    end = buffer.indexOf('\n');
  }
});
process.stdin.on('close', () => { bridge.close(); process.exit(0); });

async function handle(line) {
  let message;
  try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: relay.protocolVersion, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: serverId, version: String(descriptor.version) } } }); return;
  }
  if (method === 'ping') { send({ id, result: {} }); return; }
  if (method === 'tools/list') {
    send({ id, result: { tools: tools.filter(tool => allowedTools.has(tool.name)) } }); return;
  }
  if (method !== 'tools/call') { send({ id, error: { code: -32601, message: 'Method not found' } }); return; }
  if (!allowedTools.has(params.name)) {
    send({ id, result: toolResult({ kind: 'blocked', reason: 'TOOL_NOT_ALLOWED' }) }); return;
  }
  const capability = descriptor.capabilities.find(item => item.toolId === params.name);
  const response = await bridge.request('capability/invoke', { serverId,
    capabilityId: capability.toolId, arguments: params.arguments ?? {} });
  if (response.ok === true && response.outcome) { send({ id, result: toolResult(response.outcome) }); return; }
  send({ id, error: { code: -32001, message: String(response.code ?? 'CAPABILITY_INVOKE_FAILED'),
    data: response.details ?? null } });
}
