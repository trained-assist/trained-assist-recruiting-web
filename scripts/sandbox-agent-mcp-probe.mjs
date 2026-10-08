#!/usr/bin/env node
// Exercises Agent Runner -> per-run MCP stdio -> host capability handlers ->
// Recruiting's HTTP handlers/page with synthetic profile and provider data.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRecruitingServer } from '../src/server.js';
import { syntheticColdSearchProvider } from '../src/candidate-search-jobs.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const runnerRoot = process.env.AI_AGENT_RUNNER_ROOT;
if (!runnerRoot) throw new Error('AI_AGENT_RUNNER_ROOT must point to an isolated Agent Runner checkout');
const nodeBin = process.execPath;
const profileId = 'profile_demo_001';
const vacancyId = 'vac_demo_001';
const tools = ['manage_cold_search_schedule', 'list_cold_search_occurrences'];
// Runner's host registry keys are the MCP tool names; the domain toolIds remain
// attached to the descriptor in MCP metadata for contract traceability.
const capabilityIds = tools;
const bindingRef = `cred:recruiting-${randomBytes(5).toString('hex')}`;
const bindingSecret = `synthetic-binding-${randomBytes(16).toString('hex')}`;
const workDir = mkdtempSync(join(tmpdir(), 'recruiting-agent-mcp-sandbox-'));
const evidenceFor = events => events.trim().split('\n').map(JSON.parse)
  .filter(event => event.type === 'log' && event.payload?.stream === 'stdout' &&
    event.payload.message.startsWith('mcp-evidence: '))
  .map(event => JSON.parse(event.payload.message.slice('mcp-evidence: '.length)));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const withTimeout = (promise, ms, message) => {
  let timeout;
  return Promise.race([promise, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timeout));
};
let activeInvocationGate = null;
let now = new Date('2026-10-08T00:00:00.000Z');
const scheduleRequest = async (_profileId, requestedVacancyId) => requestedVacancyId === vacancyId ? ({
  vacancyId, criteriaRevision: 'criteria-search-demo-r1',
  criteria: { keywords: ['synthetic candidate'], regions: ['region_demo_001'] }
}) : null;
const server = createRecruitingServer({
  resolveTrustedProfileContext: req => req.headers['x-test-principal'] === profileId
    ? { profileId, scopes: ['recruiting.candidateSearch'] } : null,
  resolveCurrentSearchCriteriaRevision: () => 'criteria-search-demo-r1',
  resolveScheduledSearchRequest: scheduleRequest,
  scheduleClock: () => new Date(now),
  candidateSearchProvider: syntheticColdSearchProvider
});
let runner;
try {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const site = `http://127.0.0.1:${server.address().port}`;
  const auth = { 'X-Test-Principal': profileId };
  const [{ Runner }, { CapabilityRegistry }, { FakeEngine }, { validateRunSpec }] = await Promise.all([
    import(pathToFileURL(join(runnerRoot, 'dist/runner/runner.js')).href),
    import(pathToFileURL(join(runnerRoot, 'dist/mcp/capabilities.js')).href),
    import(pathToFileURL(join(runnerRoot, 'dist/adapters/engine/fake-engine.js')).href),
    import(pathToFileURL(join(runnerRoot, 'dist/contracts/run-spec.js')).href)
  ]);
  const makeCapability = (name, capabilityId, effect) => ({
    capabilityId, capabilityVersion: 1,
    requiredScopes: ['recruiting.candidateSearch'], requiredArguments: [], effect,
    description: 'Recruiting cold-search operation over the actual HTTP handler',
    async invoke(invocation, context) {
      if (invocation.caller.profileId !== profileId || context.bindingValue !== bindingSecret)
        return { kind: 'blocked', reason: 'synthetic trusted-profile binding mismatch' };
      // Hold one real host invocation so the test can inspect the ephemeral
      // engine config before Agent Runner removes the temporary workspace.
      const invocationGate = activeInvocationGate;
      if (invocationGate) {
        invocationGate.reached.resolve();
        await invocationGate.resume.promise;
      }
      const { action, vacancyId: requestedVacancy = vacancyId, interval_hours } = invocation.arguments;
      if (capabilityId === capabilityIds[0]) {
        const response = await fetch(`${site}/api/hh/proactive/vacancy-state`, {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, vacancy_id: requestedVacancy, ...(interval_hours ? { interval_hours } : {}) })
        });
        if (!response.ok) return { kind: 'technical_error', code: `RECRUITING_HTTP_${response.status}` };
        return { kind: 'completed', result: await response.json(), effectReceipt: {
          receiptId: `sandbox-receipt-${randomBytes(6).toString('hex')}`, capabilityId,
          capabilityVersion: 1, operationId: invocation.caller.operationId,
          bindingRef: invocation.binding.ref, at: new Date().toISOString()
        } };
      }
      const path = `/api/hh/proactive/occurrences?vacancy_id=${encodeURIComponent(requestedVacancy)}`;
      const response = await fetch(`${site}${path}`, { headers: auth });
      return response.ok ? { kind: 'completed', result: await response.json() } : { kind: 'technical_error', code: `RECRUITING_HTTP_${response.status}` };
    }
  });
  const registry = new CapabilityRegistry();
  registry.register(makeCapability(tools[0], capabilityIds[0], 'write'));
  registry.register(makeCapability(tools[1], capabilityIds[1], 'read'));
  const binding = { ref: bindingRef, scope: 'recruiting.candidateSearch' };
  const facade = join(root, 'test/fixtures/recruiting-runner-mcp.mjs');
  process.env.RECRUITING_AGENT_RUNNER_ROOT = runnerRoot;
  process.env.MCP_ALLOWED_TOOLS = tools.join(',');
  runner = new Runner({ rootDir: workDir, adapters: { fake: new FakeEngine('mcp-tools') },
    host: { region: 'sandbox-eu', environment: 'sandbox' }, cancelGraceMs: 500,
    capabilities: registry, bindingResolver: ref => ref === bindingRef ? bindingSecret : null });
  const agentRuns = [];
  const invokeAgent = async (call, callerProfileId = profileId, denied = []) => {
    const cwd = join(workDir, `agent-workspace-${agentRuns.length + 1}`);
    const rawSpec = { contractVersion: 1, jobId: `job-${randomBytes(4).toString('hex')}`,
      runId: `run-${randomBytes(6).toString('hex')}`, operationId: `op-${randomBytes(6).toString('hex')}`,
      userTaskId: `task-${randomBytes(6).toString('hex')}`, profileId: callerProfileId,
      conversationId: `conv-${randomBytes(6).toString('hex')}`, ownerGeneration: 1,
      engine: { name: 'fake', adapterVersion: '1' }, cwd,
      envAllowlist: [], limits: { timeoutMs: 60_000 }, credentialBindings: [binding],
      mcp: { servers: [{ serverId: 'recruiting-web-sandbox', transport: 'stdio', command: nodeBin,
        args: [facade], envAllowlist: ['PATH', 'RECRUITING_AGENT_RUNNER_ROOT', 'MCP_ALLOWED_TOOLS'],
        bindingRef, allowedTools: tools }] },
      input: { inlinePrompt: JSON.stringify({ calls: call ? [call] : [], denied }) } };
    const validated = validateRunSpec(rawSpec);
    assert.equal(validated.ok, true, validated.errors?.join('; '));
    const invocationGate = call ? { reached: deferred(), resume: deferred() } : null;
    activeInvocationGate = invocationGate;
    const receipt = runner.start(validated.value);
    const outcomePromise = runner.waitFor(receipt.runId, 30_000);
    if (invocationGate) {
      try {
        await Promise.race([
          withTimeout(invocationGate.reached.promise, 10_000,
            'Agent Runner did not reach the expected Recruiting capability invocation'),
          outcomePromise.then(outcome => {
            const eventsPath = join(workDir, 'runs', receipt.runId, 'events.jsonl');
            const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '(no retained events)';
            throw new Error(`Agent Run ended before the expected capability invocation: ${JSON.stringify(outcome)}\n${events}`);
          })
        ]);
        const configPath = join(cwd, '.runner', 'mcp.json');
        assert.equal(existsSync(configPath), true, 'ephemeral MCP config must exist during invocation');
        assert.equal(statSync(configPath).mode & 0o777, 0o600, 'ephemeral MCP config must be mode 0600');
        const engineConfig = readFileSync(configPath, 'utf8');
        assert.doesNotMatch(engineConfig, new RegExp(bindingSecret),
          'ephemeral MCP config must not contain the resolved binding secret');
      } finally {
        invocationGate.resume.resolve();
        activeInvocationGate = null;
      }
    }
    const outcome = await outcomePromise;
    const runRoot = join(workDir, 'runs', receipt.runId);
    const debugEvents = readFileSync(join(runRoot, 'events.jsonl'), 'utf8');
    assert.equal(outcome.outcome, 'succeeded', `${JSON.stringify(outcome)}\n${debugEvents}`);
    assert.equal(existsSync(cwd), false, 'Runner must remove the transient agent workspace');
    const evidence = evidenceFor(debugEvents);
    const listed = evidence.find(item => item.step === 'tools_list');
    const toolCall = evidence.find(item => item.step === 'tool_call');
    const deniedProbe = evidence.find(item => item.step === 'tool_call_denied_probe');
    assert.ok(tools.every(name => listed?.tools.some(tool => tool.name === name)));
    if (call) assert.equal(toolCall?.ok, true, JSON.stringify(toolCall));
    if (denied.length) assert.equal(deniedProbe?.ok, true, JSON.stringify(deniedProbe));
    agentRuns.push({ debugEvents, output: outcome.text ?? '' });
    return toolCall?.result ?? deniedProbe;
  };
  const enabled = await invokeAgent({ tool: tools[0], arguments: { action: 'enable', vacancyId, interval_hours: 6 } });
  assert.equal(enabled.schedule.enabled, true);
  assert.equal(enabled.schedule.profileId, profileId);
  const scheduled = await (await fetch(`${site}/api/hh/proactive/schedule?vacancy_id=${vacancyId}`, { headers: auth })).json();
  assert.equal(scheduled.schedules[0].enabled, true);
  now = new Date(scheduled.schedules[0].nextRunAt);
  const tick = await server.coldSearchSchedules.tick('sandbox-scheduled-worker');
  assert.deepEqual(tick, { claimed: 1, completed: 1, unknown: 0 });
  const occurrences = await invokeAgent({ tool: tools[1], arguments: { vacancyId } });
  assert.equal(occurrences.occurrences.length, 1);
  assert.equal(occurrences.occurrences[0].status, 'succeeded');
  assert.equal(occurrences.occurrences[0].snapshot.resultCount, 3);
  const deniedProfile = await invokeAgent(null, 'profile_demo_002', [
    { tool: tools[1], arguments: { vacancyId } }
  ]);
  assert.equal(deniedProfile.expect, 'refused');
  const pageResponse = await fetch(`${site}/hh/proactive?vacancy_id=${vacancyId}`, { headers: auth });
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /<title>Fresh candidates<\/title>/);
  assert.match(page, /id="candidates"/);
  const pageScript = readFileSync(join(root, 'public/proactive.js'), 'utf8');
  assert.match(pageScript, /candidates\?vacancy_id=/);
  assert.match(pageScript, /candidate\.title/);
  assert.match(pageScript, /candidate\.isNew/);
  assert.match(pageScript, /candidatesNode\.append\(row\)/);
  const feed = await (await fetch(`${site}/api/hh/proactive/candidates?vacancy_id=${vacancyId}`, { headers: auth })).json();
  assert.equal(feed.status, 'completed');
  assert.ok(feed.total > 0);
  assert.equal(feed.source, 'scheduled');
  assert.ok(feed.candidates.every(item => item.candidateRef && item.title && item.isNew === true));
  const surfaces = agentRuns.flatMap(({ debugEvents, output }) => [debugEvents, output]);
  assert.equal(surfaces.some(value => value.includes(bindingSecret)), false,
    'the synthetic binding secret must not be persisted in Agent Run evidence or MCP config');
  process.stdout.write(`${JSON.stringify({ outcome: 'pass', runner: 'FakeEngine over Agent Runner MCP bridge',
    siteTransport: 'local Recruiting HTTP server', profileId, tools, schedule: scheduled.schedules[0].enabled,
    page: pageResponse.status, browserRenderContract: 'candidate title/NEW/region rendered from candidate feed',
    schedulerTick: tick, freshCandidates: feed.total, source: feed.source,
    crossProfileMcpCall: 'refused' })}\n`);
} finally {
  runner?.dispose();
  await new Promise(resolveClose => server.close(resolveClose));
  rmSync(workDir, { recursive: true, force: true });
}
