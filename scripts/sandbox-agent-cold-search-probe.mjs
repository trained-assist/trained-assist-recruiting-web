#!/usr/bin/env node
// Agent Runner FakeEngine -> stdio MCP bridge -> public stable sandbox -> synthetic HTTP handlers.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runnerRoot = resolve(process.env.AI_AGENT_RUNNER_ROOT ?? '');
const publicOrigin = (process.env.RECRUITING_SANDBOX_PUBLIC_ORIGIN ?? '').replace(/\/$/, '');
if (!process.env.AI_AGENT_RUNNER_ROOT) throw new Error('AI_AGENT_RUNNER_ROOT must point to an isolated built Agent Runner checkout');
if (!publicOrigin) throw new Error('RECRUITING_SANDBOX_PUBLIC_ORIGIN must point to the stable synthetic sandbox ingress');
const origin = new URL(publicOrigin);
assert.equal(origin.protocol, 'https:');
assert.match(origin.hostname, /^[a-z0-9-]+\.skillset-apply\.workers\.dev$/);
const profileId = 'profile_demo_001';
const vacancyId = 'vac_demo_001';
const cookieName = '__Host-recruiting-sandbox';
const serverId = 'recruiting-web-public-sandbox';
const bindingRef = `cred:recruiting-sandbox-${randomBytes(6).toString('hex')}`;
const workDir = mkdtempSync(join(tmpdir(), 'recruiting-agent-public-mcp-'));
const toolNames = ['recruiting.cold_search.manage_schedule', 'recruiting.cold_search.list_occurrences'];
const parseCookie = response => response.headers.getSetCookie().map(value => value.split(';', 1)[0])
  .find(value => value.startsWith(`${cookieName}=`));
const request = (path, options = {}) => fetch(`${publicOrigin}${path}`, { redirect: 'manual', ...options });
const readMcpEvidence = runRoot => readFileSync(join(runRoot, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  .filter(event => event.type === 'log' && event.payload?.stream === 'stdout' &&
    event.payload.message.startsWith('mcp-evidence: '))
  .map(event => JSON.parse(event.payload.message.slice('mcp-evidence: '.length)));
let runner;

try {
  const login = await request('/__sandbox-login');
  assert.equal(login.status, 303);
  const session = parseCookie(login);
  assert.ok(session, 'sandbox login must return a synthetic profile session');
  const pagePath = new URL(login.headers.get('location'), publicOrigin).pathname +
    new URL(login.headers.get('location'), publicOrigin).search;
  const page = await request(pagePath, { headers: { cookie: session } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Fresh candidates/);

  const [{ Runner }, { CapabilityRegistry }, { FakeEngine }, { validateRunSpec }] = await Promise.all([
    import(pathToFileURL(join(runnerRoot, 'dist/runner/runner.js')).href),
    import(pathToFileURL(join(runnerRoot, 'dist/mcp/capabilities.js')).href),
    import(pathToFileURL(join(runnerRoot, 'dist/adapters/engine/fake-engine.js')).href),
    import(pathToFileURL(join(runnerRoot, 'dist/contracts/run-spec.js')).href)
  ]);
  const capabilities = JSON.parse(readFileSync(join(root, 'contracts/recruiting-capabilities-v1.json'), 'utf8')).capabilities;
  const registry = new CapabilityRegistry();
  for (const definition of capabilities) {
    const descriptor = { capabilityId: definition.toolId, capabilityVersion: 1,
      requiredScopes: definition.requiredScopes, requiredArguments: definition.name === 'manage_cold_search_schedule' ? ['action'] : [],
      effect: definition.effect, description: definition.description,
      async invoke(invocation, context) {
        if (invocation.caller.profileId !== profileId || context.bindingValue !== session)
          return { kind: 'blocked', reason: 'synthetic profile/session binding mismatch' };
        const args = invocation.arguments ?? {};
        const toolName = definition.name;
        const targetVacancy = args.vacancyId ?? vacancyId;
        if (targetVacancy !== vacancyId) return { kind: 'blocked', reason: 'vacancy is outside synthetic sandbox scope' };
        let response;
        if (toolName === 'manage_cold_search_schedule' && args.action === 'status') {
          response = await request(`/api/hh/proactive/schedule?vacancy_id=${encodeURIComponent(vacancyId)}`,
            { headers: { cookie: context.bindingValue } });
        } else if (toolName === 'manage_cold_search_schedule') {
          response = await request('/api/hh/proactive/vacancy-state', { method: 'POST',
            headers: { cookie: context.bindingValue, 'content-type': 'application/json' },
            body: JSON.stringify({ vacancy_id: vacancyId, action: args.action,
              ...(args.action === 'enable' && 'interval_hours' in args ? { interval_hours: args.interval_hours } : {}) }) });
        } else {
          response = await request(`/api/hh/proactive/occurrences?vacancy_id=${encodeURIComponent(vacancyId)}`,
            { headers: { cookie: context.bindingValue } });
        }
        const result = await response.json();
        if (!response.ok) return { kind: 'technical_error', code: `RECRUITING_HTTP_${response.status}` };
        return { kind: 'completed', result };
      }
    };
    registry.register(descriptor);
  }

  runner = new Runner({ rootDir: workDir, adapters: { fake: new FakeEngine('mcp-tools') },
    host: { region: 'sandbox-eu', environment: 'sandbox' }, cancelGraceMs: 500, capabilities: registry,
    bindingResolver: ref => ref === bindingRef ? session : null });
  process.env.AI_AGENT_RUNNER_ROOT = runnerRoot;
  process.env.MCP_ALLOWED_TOOLS = capabilities.map(item => item.toolId).join(',');
  const facade = join(root, 'test/fixtures/recruiting-sandbox-runner-mcp.mjs');
  const envAllowlist = ['PATH', 'AI_AGENT_RUNNER_ROOT', 'MCP_ALLOWED_TOOLS'];
  let runIndex = 0;
  const invoke = async ({ calls, denied = [], profile = profileId }) => {
    const cwd = join(workDir, `agent-workspace-${++runIndex}`);
    const rawSpec = { contractVersion: 1, jobId: `job-${process.pid}-${runIndex}`,
      runId: `run-${process.pid}-${runIndex}`, operationId: `op-${process.pid}-${runIndex}`,
      userTaskId: `task-${process.pid}`, profileId: profile, conversationId: `conv-${process.pid}`,
      ownerGeneration: 1, engine: { name: 'fake', adapterVersion: '1' }, cwd,
      // The persisted synthetic sandbox may retain many previous test occurrences.
      // Keep the MCP evidence below Runner's default 4 KiB log-line cap so it stays
      // complete and parseable instead of silently testing a truncated response.
      envAllowlist: [], limits: { timeoutMs: 60_000, maxLogBytes: 1_048_576 }, credentialBindings: [
        { ref: bindingRef, scope: 'recruiting.candidateSearch' }],
    mcp: { servers: [{ serverId, transport: 'stdio', command: process.execPath,
    args: [facade], envAllowlist, bindingRef, allowedTools: capabilities.map(item => item.toolId) }] },
      input: { inlinePrompt: JSON.stringify({ calls, denied }) } };
    const validated = validateRunSpec(rawSpec);
    assert.equal(validated.ok, true, validated.errors?.join('; '));
    const receipt = runner.start(validated.value);
    const outcome = await runner.waitFor(receipt.runId, 30_000);
    const runRoot = join(workDir, 'runs', receipt.runId);
    const events = readFileSync(join(runRoot, 'events.jsonl'), 'utf8');
    assert.equal(outcome.outcome, 'succeeded', `${JSON.stringify(outcome)}\n${events}`);
    assert.equal(existsSync(cwd), false, 'Runner should sweep the temporary MCP workspace');
    return { receipt, evidence: readMcpEvidence(runRoot), eventText: events };
  };

  const statusRun = await invoke({ calls: [
    { tool: toolNames[0], arguments: { action: 'status', vacancyId } },
    { tool: toolNames[1], arguments: { vacancyId } }
  ] });
  const listed = statusRun.evidence.find(item => item.step === 'tools_list');
  const status = statusRun.evidence.find(item => item.step === 'tool_call' && item.tool === toolNames[0]);
  const occurrences = statusRun.evidence.find(item => item.step === 'tool_call' && item.tool === toolNames[1]);
  assert.ok(toolNames.every(name => listed?.tools.some(tool => tool.name === name)));
  assert.equal(status?.ok, true, JSON.stringify(status));
  assert.equal(status.result.kind, 'status');
  assert.equal(occurrences?.ok, true, JSON.stringify(occurrences));
  assert.equal(occurrences.result.kind, 'occurrences');

  const enableRun = await invoke({ calls: [{ tool: toolNames[0], arguments: {
    action: 'enable', vacancyId, interval_hours: 24
  } }] });
  const enabled = enableRun.evidence.find(item => item.step === 'tool_call');
  assert.equal(enabled?.ok, true, JSON.stringify(enabled));
  assert.equal(enabled.result.kind, 'updated');
  assert.equal(enabled.result.schedule.enabled, true);
  const crossProfile = await invoke({ profile: 'profile_demo_002', denied: [
    { tool: toolNames[0], arguments: { action: 'status', vacancyId } }
  ] });
  assert.equal(crossProfile.evidence.find(item => item.step === 'tool_call_denied_probe')?.expect, 'refused');

  const tick = await request(`/__sandbox/tick?vacancy_id=${encodeURIComponent(vacancyId)}`, { headers: { cookie: session } });
  assert.equal(tick.status, 200, await tick.clone().text());
  const tickResult = await tick.json();
  assert.equal(tickResult.outcome, 'synthetic_tick');
  const afterRun = await invoke({ calls: [
    { tool: toolNames[1], arguments: { vacancyId } },
    { tool: toolNames[0], arguments: { action: 'status', vacancyId } }
  ] });
  const afterOccurrences = afterRun.evidence.find(item => item.step === 'tool_call' && item.tool === toolNames[1]);
  const afterStatus = afterRun.evidence.find(item => item.step === 'tool_call' && item.tool === toolNames[0]);
  assert.equal(afterOccurrences?.ok, true, JSON.stringify(afterOccurrences));
  assert.equal(afterOccurrences.result.occurrences.length > 0, true);
  assert.equal(afterStatus?.result.schedules[0]?.enabled, true);
  const feed = await request(`/api/hh/proactive/candidates?vacancy_id=${encodeURIComponent(vacancyId)}`,
    { headers: { cookie: session } });
  assert.equal(feed.status, 200);
  const feedData = await feed.json();
  assert.equal(feedData.total > 0, true);

  const artifacts = [statusRun, enableRun, crossProfile, afterRun].flatMap(({ receipt, eventText }) => [
    ...['events.jsonl', 'state.json', 'result.json'].map(name => readFileSync(join(workDir, 'runs', receipt.runId, name), 'utf8')),
    eventText
  ]);
  assert.equal(artifacts.some(value => value.includes(session)), false,
    'sandbox session cookie must not be persisted in Agent Run evidence/config');
  process.stdout.write(`${JSON.stringify({ outcome: 'pass', runner: 'FakeEngine over Agent Runner MCP bridge',
    siteTransport: 'stable Workers.dev -> Quick Tunnel -> synthetic Recruiting HTTP handlers',
    profileId, tools: toolNames, scheduleEnabled: true, syntheticScheduledTick: tickResult.outcome,
    freshCandidates: feedData.total, occurrences: afterOccurrences.result.occurrences.length,
    crossProfileCall: 'refused', sessionBindingPersisted: false })}\n`);
} finally {
  runner?.dispose();
  rmSync(workDir, { recursive: true, force: true });
}
