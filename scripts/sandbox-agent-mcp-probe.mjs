#!/usr/bin/env node
// Exercises Agent Runner -> per-run MCP stdio -> host capability handlers ->
// Recruiting's HTTP handlers/page with synthetic profile and provider data.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const scheduleRequest = async (_profileId, requestedVacancyId) => requestedVacancyId === vacancyId ? ({
  vacancyId, criteriaRevision: 'criteria-search-demo-r1',
  criteria: { keywords: ['synthetic candidate'], regions: ['region_demo_001'] }
}) : null;
const server = createRecruitingServer({
  resolveTrustedProfileContext: req => req.headers['x-test-principal'] === profileId
    ? { profileId, scopes: ['recruiting.candidateSearch'] } : null,
  resolveCurrentSearchCriteriaRevision: () => 'criteria-search-demo-r1',
  resolveScheduledSearchRequest: scheduleRequest,
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
  const rawSpec = { contractVersion: 1, jobId: `job-${randomBytes(4).toString('hex')}`,
    runId: `run-${randomBytes(6).toString('hex')}`, operationId: `op-${randomBytes(6).toString('hex')}`,
    userTaskId: `task-${randomBytes(6).toString('hex')}`, profileId,
    conversationId: `conv-${randomBytes(6).toString('hex')}`, ownerGeneration: 1,
    engine: { name: 'fake', adapterVersion: '1' }, cwd: join(workDir, 'agent-workspace'),
    envAllowlist: [], limits: { timeoutMs: 60_000 }, credentialBindings: [binding],
    mcp: { servers: [{ serverId: 'recruiting-web-sandbox', transport: 'stdio', command: nodeBin,
      args: [facade], envAllowlist: ['PATH', 'RECRUITING_AGENT_RUNNER_ROOT', 'MCP_ALLOWED_TOOLS'],
      bindingRef, allowedTools: tools }] },
    input: { inlinePrompt: JSON.stringify({ calls: [
      { tool: tools[0], arguments: { action: 'enable', vacancyId, interval_hours: 6 } },
      { tool: tools[1], arguments: { vacancyId } }
    ], denied: [] }) } };
  const validated = validateRunSpec(rawSpec);
  assert.equal(validated.ok, true, validated.errors?.join('; '));
  const receipt = runner.start(validated.value);
  const outcome = await runner.waitFor(receipt.runId, 30_000);
  const debugEvents = readFileSync(join(workDir, 'runs', receipt.runId, 'events.jsonl'), 'utf8');
  assert.equal(outcome.outcome, 'succeeded', `${JSON.stringify(outcome)}\n${debugEvents}`);
  const evidenceText = readFileSync(join(validated.value.cwd, 'mcp-evidence.jsonl'), 'utf8');
  const evidence = evidenceText.trim().split('\n').map(JSON.parse);
  const listed = evidence.find(item => item.step === 'tools_list');
  const calls = evidence.filter(item => item.step === 'tool_call');
  assert.ok(tools.every(name => listed?.tools.some(tool => tool.name === name)));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(item => item.ok), JSON.stringify(calls));
  assert.equal(calls[0].result.schedule.enabled, true);
  assert.equal(calls[0].result.schedule.profileId, profileId);
  assert.deepEqual(calls[1].result.occurrences, []);

  const scheduled = await (await fetch(`${site}/api/hh/proactive/schedule?vacancy_id=${vacancyId}`, { headers: auth })).json();
  assert.equal(scheduled.schedules[0].enabled, true);
  const pageResponse = await fetch(`${site}/hh/proactive?vacancy_id=${vacancyId}`, { headers: auth });
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /fresh|candidate|кандидат/i);
  const manual = await fetch(`${site}/api/hh/proactive/search`, { method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'agent-sandbox-search-01' },
    body: JSON.stringify({ vacancy_id: vacancyId }) });
  assert.equal(manual.status, 200, await manual.text());
  const feed = await (await fetch(`${site}/api/hh/proactive/candidates?vacancy_id=${vacancyId}`, { headers: auth })).json();
  assert.equal(feed.status, 'completed');
  assert.ok(feed.total > 0);
  assert.ok(feed.candidates.every(item => item.candidateRef && item.title && item.isNew === true));
  const runRoot = join(workDir, 'runs', receipt.runId);
  const surfaces = ['events.jsonl', 'state.json', 'result.json'].map(name => readFileSync(join(runRoot, name), 'utf8'));
  surfaces.push(evidenceText, readFileSync(join(validated.value.cwd, '.runner/mcp.json'), 'utf8'));
  assert.equal(surfaces.some(value => value.includes(bindingSecret)), false,
    'the synthetic binding secret must not be persisted in Agent Run evidence or MCP config');
  process.stdout.write(`${JSON.stringify({ outcome: 'pass', runner: 'FakeEngine over Agent Runner MCP bridge',
    siteTransport: 'local Recruiting HTTP server', profileId, tools, schedule: scheduled.schedules[0].enabled,
    page: pageResponse.status, freshCandidates: feed.total, source: feed.source })}\n`);
} finally {
  runner?.dispose();
  await new Promise(resolveClose => server.close(resolveClose));
  rmSync(workDir, { recursive: true, force: true });
}
