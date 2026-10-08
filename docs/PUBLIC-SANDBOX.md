# Temporary public Recruiting sandbox

This sandbox makes the synthetic R-03 page reachable for external browser and MCP transport checks. It is not a deployment target and it does not use HH, Control Plane, Agent profile authority, real candidate data, or durable storage.

## Run

From a clean checkout with dependencies installed and a built Agent Runner checkout available:

```sh
npm ci
node scripts/public-sandbox-server.mjs
```

The server binds only to `127.0.0.1:34427` by default. In another terminal, expose that port with a temporary Cloudflare Quick Tunnel:

```sh
cloudflared tunnel --url http://127.0.0.1:34427 --no-autoupdate
```

Use the `https://<random>.trycloudflare.com` URL printed by Cloudflare. The candidate page is `/hh/proactive?vacancy_id=vac_demo_001`.

Verify public MCP calls against the same URL:

```sh
AI_AGENT_RUNNER_ROOT=/path/to/built/ai-agent-runner \
RECRUITING_SANDBOX_PUBLIC_ORIGIN=https://<random>.trycloudflare.com \
node scripts/public-sandbox-agent-mcp-probe.mjs
```

## Data and isolation

- Every request is bound to the invented `profile_demo_001`; browser input cannot choose a profile.
- Only `vac_demo_001` and `syntheticColdSearchProvider` are used. The candidate fixture contains no people or copied records.
- The process seeds one due scheduled occurrence at the current wall-clock time, then runs an in-memory timer. Restarting resets all schedules, occurrences and results.
- The sandbox has no real HH, client, Control Plane, Weeek, production MCP registry, or credentials. The MCP probe uses Agent Runner `FakeEngine` and synthetic capability bindings.
- The public URL is temporary. It stops working when either the local server or Cloudflare tunnel stops. Do not use this link as a production/staging service.

The normal `npm test` and `npm run test:sandbox:agent-mcp` remain local contract checks; this optional probe adds public network transport evidence only.
