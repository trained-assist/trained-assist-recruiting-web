import test from "node:test";
import assert from "node:assert/strict";
import { proxySandboxRequest } from "../src/sandbox-edge-proxy.js";

test("sandbox edge proxy forwards same-origin browser traffic and hides the temporary upstream", async () => {
  let target, init;
  const response = await proxySandboxRequest(new Request("https://recruiting-sandbox.example.test/api/demo?q=1", {
    headers: { cookie: "sandbox-session=synthetic", "x-forwarded-for": "192.0.2.1" }
  }), "https://local-tunnel.trycloudflare.com", async (url, options) => {
    target = url; init = options;
    return new Response(null, { status: 303, headers: { location: "https://local-tunnel.trycloudflare.com/hh/proactive?q=2", "set-cookie": "__Host-session=synthetic; Secure; Path=/" } });
  });
  assert.equal(target.href, "https://local-tunnel.trycloudflare.com/api/demo?q=1");
  assert.equal(init.headers.get("cookie"), "sandbox-session=synthetic");
  assert.equal(init.headers.has("x-forwarded-for"), false);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/hh/proactive?q=2");
  assert.match(response.headers.get("set-cookie"), /__Host-session=synthetic/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("sandbox edge proxy refuses arbitrary upstreams and unsupported methods", async () => {
  const bad = await proxySandboxRequest(new Request("https://proxy.example.test/"), "https://example.com");
  assert.equal(bad.status, 503);
  const method = await proxySandboxRequest({ method: "TRACE" }, "https://local-tunnel.trycloudflare.com");
  assert.equal(method.status, 405);
});

test("sandbox edge proxy preserves private no-store on approved report downloads", async () => {
  const response = await proxySandboxRequest(new Request("https://recruiting-sandbox.example.test/api/report/export", {
    method: "POST"
  }), "https://local-tunnel.trycloudflare.com", async () => new Response("synthetic report", {
    status: 200, headers: { "cache-control": "private, no-store", "content-disposition": 'attachment; filename="candidate-report-report_0123456789abcdef0123456789abcdef.html"' }
  }));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="candidate-report-report_0123456789abcdef0123456789abcdef.html"');
});
