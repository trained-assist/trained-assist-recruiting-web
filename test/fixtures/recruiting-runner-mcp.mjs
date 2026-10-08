#!/usr/bin/env node
// Per-run MCP facade for the Agent Runner sandbox probe. Invocation is handled
// by the isolated Runner host and forwarded to the Recruiting HTTP handlers.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const protocolVersion = '2025-06-18';
const root = new URL('../../', import.meta.url);
const descriptor = JSON.parse(readFileSync(new URL('contracts/recruiting-capabilities-v1.json', root), 'utf8'));
const serverId = process.env.MCP_SERVER_ID ?? 'recruiting-web-sandbox';
const allowedTools = new Set((process.env.MCP_ALLOWED_TOOLS ?? '').split(',').filter(Boolean));
const runnerRoot = process.env.RECRUITING_AGENT_RUNNER_ROOT;
if (!runnerRoot) throw new Error('RECRUITING_AGENT_RUNNER_ROOT is required by the sandbox-only MCP facade');
const { BridgeClient } = await import(pathToFileURL(join(runnerRoot, 'src/mcp/fixtures/bridge-client.mjs')).href);
const bridge = new BridgeClient({ url: process.env.MCP_BRIDGE_URL ?? '', runToken: process.env.MCP_BRIDGE_TOKEN ?? '', serverId });
await bridge.open();
const tools = descriptor.capabilities.map(capability => ({
  name: capability.name, description: capability.description,
  inputSchema: JSON.parse(readFileSync(new URL(`contracts/${capability.inputSchemaRef}`, root), 'utf8')),
  _meta: { capabilityId: capability.toolId, capabilityVersion: 1 }
}));
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const result = outcome => ({ content: [{ type: 'text', text: JSON.stringify({ outcome }) }], structuredContent: { outcome } });
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
  let request;
  try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const { id, method, params = {} } = request;
  if (id === undefined || id === null) return;
  if (method === 'initialize') { send({ id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'recruiting-web-sandbox', version: '1' } } }); return; }
  if (method === 'ping') { send({ id, result: {} }); return; }
  if (method === 'tools/list') { send({ id, result: { tools: tools.filter(tool => allowedTools.has(tool.name)) } }); return; }
  if (method !== 'tools/call') { send({ id, error: { code: -32601, message: 'Method not found' } }); return; }
  if (!allowedTools.has(params.name)) { send({ id, result: result({ kind: 'technical_error', code: 'TOOL_NOT_ALLOWED' }), isError: true }); return; }
  const capability = descriptor.capabilities.find(item => item.name === params.name);
  const response = await bridge.request('capability/invoke', { serverId, capabilityId: capability.name, arguments: params.arguments ?? {} });
  if (response.ok === true && response.outcome) send({ id, result: result(response.outcome), ...(response.outcome.kind === 'completed' ? {} : { isError: true }) });
  else {
    process.stderr.write(`sandbox_bridge_failure ${JSON.stringify({ code: response.code, details: response.details ?? null })}\n`);
    send({ id, error: { code: -32001, message: String(response.code ?? 'CAPABILITY_INVOKE_FAILED'), data: response.details ?? null } });
  }
}
