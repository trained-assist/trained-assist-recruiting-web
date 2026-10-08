#!/usr/bin/env node
// Agent Runner MCP -> Cloudflare Quick Tunnel -> synthetic Recruiting HTTP handlers.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(new URL('..', import.meta.url).pathname);
const runnerRoot = resolve(process.env.AI_AGENT_RUNNER_ROOT ?? '');
const origin = (process.env.RECRUITING_SANDBOX_PUBLIC_ORIGIN ?? '').replace(/\/$/, '');
if (!process.env.AI_AGENT_RUNNER_ROOT || !process.env.RECRUITING_SANDBOX_PUBLIC_ORIGIN) {
  throw new Error('AI_AGENT_RUNNER_ROOT and RECRUITING_SANDBOX_PUBLIC_ORIGIN are required');
}
const parsedOrigin = new URL(origin);
assert.equal(parsedOrigin.protocol, 'https:');
assert.match(parsedOrigin.hostname, /^[a-z0-9-]+\.trycloudflare\.com$/,
  'public probe only accepts a Cloudflare Quick Tunnel hostname');

const profileId = 'profile_demo_001';
const vacancyId = 'vac_demo_001';
const descriptor = JSON.parse(readFileSync(join(root, 'contracts/recruiting-capabilities-v1.json'), 'utf8'));
const capabilities = ['manage_cold_search_schedule', 'list_cold_search_occurrences'].map(name => {
  const capability = descriptor.capabilities.find(item => item.name === name);
  assert.ok(capability, `Missing descriptor capability: ${name}`);
  return capability;
});
const bindingRef = `cred:recruiting-public-${randomBytes(5).toString('hex')}`;
const bindingSecret = `synthetic-binding-${randomBytes(16).toString('hex')}`;
const workDir = mkdtempSync(join(tmpdir(), 'recruiting-public-mcp-'));
const [{ Runner }, { CapabilityRegistry }, { FakeEngine }, { validateRunSpec }] = await Promise.all([
  import(pathToFileURL(join(runnerRoot, 'dist/runner/runner.js')).href),
  import(pathToFileURL(join(runnerRoot, 'dist/mcp/capabilities.js')).href),
  import(pathToFileURL(join(runnerRoot, 'dist/adapters/engine/fake-engine.js')).href),
  import(pathToFileURL(join(runnerRoot, 'dist/contracts/run-spec.js')).href)
]);

const registry = new CapabilityRegistry();
for (const capability of capabilities) {
  const schema = JSON.parse(readFileSync(join(root, 'contracts', capability.inputSchemaRef), 'utf8'));
  registry.register({
    capabilityId: capability.name,
    capabilityVersion: descriptor.version,
    requiredScopes: capability.requiredScopes,
    requiredArguments: schema.required ?? [],
    effect: capability.effect === 'read' ? 'read' : 'write',
    description: capability.description,
    async invoke(invocation, context) {
      if (invocation.caller.profileId !== profileId || context.bindingValue !== bindingSecret) {
        return { kind: 'blocked', reason: 'sandbox synthetic profile/binding mismatch' };
      }
      const args = invocation.arguments ?? {};
      const selectedVacancy = encodeURIComponent(args.vacancyId ?? vacancyId);
      const path = capability.name === 'manage_cold_search_schedule'
        ? `/api/hh/proactive/vacancy-state`
        : `/api/hh/proactive/occurrences?vacancy_id=${selectedVacancy}`;
      const response = capability.name === 'manage_cold_search_schedule'
        ? await fetch(`${origin}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: args.action, vacancy_id: args.vacancyId ?? vacancyId,
              ...(args.interval_hours ? { interval_hours: args.interval_hours } : {}) })
          })
        : await fetch(`${origin}${path}`);
      if (!response.ok) return { kind: 'technical_error', code: `RECRUITING_HTTP_${response.status}` };
      const result = await response.json();
      return {
        kind: 'completed', result,
        ...(capability.mutates ? { effectReceipt: {
          receiptId: result.schedule?.scheduleId ?? `sandbox-schedule-${randomBytes(6).toString('hex')}`,
          capabilityId: capability.toolId,
          capabilityVersion: descriptor.version,
          operationId: invocation.caller.operationId,
          bindingRef: invocation.binding.ref,
          at: new Date().toISOString()
        } } : {})
      };
    }
  });
}

const serverId = 'recruiting-web-public-sandbox';
const allowedTools = capabilities.map(item => item.name);
const facade = join(root, 'test/fixtures/recruiting-runner-mcp.mjs');
process.env.RECRUITING_AGENT_RUNNER_ROOT = runnerRoot;
process.env.MCP_SERVER_ID = serverId;
process.env.MCP_ALLOWED_TOOLS = allowedTools.join(',');
const runner = new Runner({ rootDir: workDir, adapters: { fake: new FakeEngine('mcp-tools') },
  host: { region: 'sandbox-eu', environment: 'sandbox' }, cancelGraceMs: 500,
  capabilities: registry, bindingResolver: ref => ref === bindingRef ? bindingSecret : null });

async function invoke(tool, args) {
  const cwd = join(workDir, `workspace-${randomBytes(4).toString('hex')}`);
  const rawSpec = { contractVersion: 1,
    jobId: `job-${randomBytes(4).toString('hex')}`,
    runId: `run-${randomBytes(6).toString('hex')}`,
    operationId: `op-${randomBytes(6).toString('hex')}`,
    userTaskId: `task-${randomBytes(6).toString('hex')}`,
    profileId, conversationId: `conv-${randomBytes(6).toString('hex')}`, ownerGeneration: 1,
    engine: { name: 'fake', adapterVersion: '1' }, cwd, envAllowlist: [], limits: { timeoutMs: 60_000 },
    credentialBindings: [{ ref: bindingRef, scope: 'recruiting.candidateSearch' }],
    mcp: { servers: [{ serverId, transport: 'stdio', command: process.execPath,
      args: [facade], envAllowlist: ['PATH', 'RECRUITING_AGENT_RUNNER_ROOT', 'MCP_SERVER_ID', 'MCP_ALLOWED_TOOLS'],
      bindingRef, allowedTools }] },
    input: { inlinePrompt: JSON.stringify({ calls: [{ tool, arguments: args }], denied: [] }) }
  };
  const validated = validateRunSpec(rawSpec);
  assert.equal(validated.ok, true, validated.errors?.join('; '));
  const receipt = runner.start(validated.value);
  const outcome = await runner.waitFor(receipt.runId, 30_000);
  const events = readFileSync(join(workDir, 'runs', receipt.runId, 'events.jsonl'), 'utf8');
  assert.equal(outcome.outcome, 'succeeded', `${JSON.stringify(outcome)}\n${events}`);
  const evidence = events.trim().split('\n').map(JSON.parse)
    .filter(event => event.type === 'log' && event.payload?.stream === 'stdout' &&
      event.payload.message.startsWith('mcp-evidence: '))
    .map(event => JSON.parse(event.payload.message.slice('mcp-evidence: '.length)));
  const listed = evidence.find(item => item.step === 'tools_list');
  const called = evidence.find(item => item.step === 'tool_call');
  assert.ok(listed?.tools.some(item => item.name === tool));
  assert.equal(called?.ok, true, JSON.stringify(called));
  return called.result;
}

try {
  const scheduleResult = await invoke('manage_cold_search_schedule',
    { action: 'enable', vacancyId, interval_hours: 0.5 });
  assert.equal(scheduleResult.schedule.enabled, true);
  assert.equal(scheduleResult.schedule.profileId, profileId);
  const occurrenceResult = await invoke('list_cold_search_occurrences', { vacancyId });
  assert.equal(occurrenceResult.occurrences.length, 1);
  assert.equal(occurrenceResult.occurrences[0].status, 'succeeded');
  assert.equal(occurrenceResult.occurrences[0].snapshot.resultCount, 3);

  const page = await fetch(`${origin}/hh/proactive?vacancy_id=${vacancyId}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<title>Fresh candidates<\/title>/);
  const response = await fetch(`${origin}/api/hh/proactive/candidates?vacancy_id=${vacancyId}`);
  const feed = await response.json();
  assert.equal(response.status, 200);
  assert.equal(feed.status, 'completed');
  assert.equal(feed.source, 'scheduled');
  assert.equal(feed.total, 3);
  assert.ok(feed.candidates.every(candidate => candidate.isNew && candidate.title && candidate.region));
  process.stdout.write(`${JSON.stringify({ outcome: 'pass', runner: 'Agent Runner FakeEngine over MCP stdio bridge',
    serviceOrigin: origin, transport: 'Cloudflare Quick Tunnel to synthetic Recruiting HTTP server',
    profileId, tools: allowedTools, occurrence: occurrenceResult.occurrences[0].status,
    pageStatus: page.status, candidateCount: feed.total, candidateSource: feed.source, syntheticOnly: true })}\n`);
} finally {
  runner.dispose();
  rmSync(workDir, { recursive: true, force: true });
}
