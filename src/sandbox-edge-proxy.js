const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export async function proxySandboxRequest(request, upstreamOrigin, fetchImpl = fetch) {
  let upstream;
  try { upstream = new URL(upstreamOrigin); } catch { return new Response("sandbox upstream unavailable", { status: 503 }); }
  if (upstream.protocol !== "https:" || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(upstream.hostname) ||
      upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash)
    return new Response("sandbox upstream unavailable", { status: 503 });
  if (!methods.has(request.method)) return new Response("method not allowed", { status: 405, headers: { Allow: [...methods].join(", ") } });

  const incoming = new URL(request.url);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const name of ["host", "cf-connecting-ip", "forwarded", "x-forwarded-for", "x-real-ip"]) headers.delete(name);
  const init = { method: request.method, headers, redirect: "manual" };
  if (!new Set(["GET", "HEAD"]).has(request.method)) init.body = request.body;
  let result;
  try { result = await fetchImpl(upstream, init); }
  catch { return new Response("sandbox upstream unavailable", { status: 502, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } }); }

  const responseHeaders = new Headers(result.headers);
  const upstreamCacheControl = responseHeaders.get("cache-control") ?? "";
  responseHeaders.set("cache-control", /\bprivate\b/i.test(upstreamCacheControl) ? "private, no-store" : "no-store");
  responseHeaders.set("x-robots-tag", "noindex, nofollow");
  const location = responseHeaders.get("location");
  if (location) {
    try {
      const target = new URL(location, upstream);
      if (target.origin === upstream.origin) responseHeaders.set("location", `${target.pathname}${target.search}${target.hash}`);
    } catch { responseHeaders.delete("location"); }
  }
  return new Response(result.body, { status: result.status, statusText: result.statusText, headers: responseHeaders });
}

export default {
  fetch(request, env) {
    return proxySandboxRequest(request, env.UPSTREAM_ORIGIN);
  }
};
