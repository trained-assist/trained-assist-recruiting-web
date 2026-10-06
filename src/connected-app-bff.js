import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const audience = 'recruiting-web';
const pendingCookie = '__Host-recruiting-oauth-pending';
const sessionCookie = '__Host-recruiting-app-session';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export class ConnectedAppIntrospectionUnavailable extends Error {
  constructor() { super('connected_app_introspection_unavailable'); this.name = 'ConnectedAppIntrospectionUnavailable'; }
}
const cookie = (name, value, maxAge, sameSite = 'Strict') =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
const clearCookie = name => cookie(name, '', 0);
const respond = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', ...headers });
  res.end(body === null ? undefined : JSON.stringify(body));
};
function cookieValue(req, name) {
  const matches = String(req.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
}

/** Synthetic process-local fixture. A deployed BFF must inject a durable, atomic store. */
export function createMemoryConnectedAppBffStore() {
  const pending = new Map(); const sessions = new Map();
  return {
    async putPending(key, value) { pending.set(key, structuredClone(value)); },
    async takePending(key) { const value = pending.get(key) ?? null; pending.delete(key); return value; },
    async putSession(key, value) { sessions.set(key, structuredClone(value)); },
    async getSession(key) { return sessions.get(key) ?? null; },
    async deleteSession(key) { sessions.delete(key); },
  };
}

/** CP service calls remain server-side. No app or browser receives this credential. */
export function createControlPlaneConnectedAppClient({ issuer, allowedIssuerOrigins, serviceKey, fetcher = fetch } = {}) {
  if (typeof issuer !== 'string' || !issuer.startsWith('https://') || new URL(issuer).origin !== issuer ||
      !Array.isArray(allowedIssuerOrigins) || !allowedIssuerOrigins.includes(issuer) ||
      typeof serviceKey !== 'string' || serviceKey.length < 32 || typeof fetcher !== 'function')
    throw new TypeError('connected_app_client_configuration_required');
  const headers = { authorization: `Bearer ${serviceKey}` };
  return {
    async exchangeCode({ code, state, verifier, redirectUri }) {
      const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: audience,
        redirect_uri: redirectUri, code, state, code_verifier: verifier });
      const response = await fetcher(`${issuer}/v1/connected-app-sessions/exchange`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        body, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      return response.json();
    },
    async introspectToken(token) {
      const response = await fetcher(`${issuer}/v1/connected-app-sessions/introspect`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ token, audience }), redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new ConnectedAppIntrospectionUnavailable();
      try { return await response.json(); }
      catch { throw new ConnectedAppIntrospectionUnavailable(); }
    },
  };
}

/** Explicit opt-in Node BFF boundary; never constructed by the default server. */
export function createRecruitingConnectedAppBff({ issuer, allowedIssuerOrigins, publicOrigin, redirectUri, store,
  exchangeCode, introspectToken, clock = () => Date.now(), scopes = ['recruiting.responses.read', 'recruiting.reports.read'] } = {}) {
  if (typeof issuer !== 'string' || !issuer.startsWith('https://') || new URL(issuer).origin !== issuer ||
      !Array.isArray(allowedIssuerOrigins) || !allowedIssuerOrigins.includes(issuer) ||
      typeof publicOrigin !== 'string' || !publicOrigin.startsWith('https://') || new URL(publicOrigin).origin !== publicOrigin ||
      redirectUri !== `${publicOrigin}/auth/connected/callback` ||
      !store || !['putPending', 'takePending', 'putSession', 'getSession', 'deleteSession'].every(method => typeof store[method] === 'function') ||
      typeof exchangeCode !== 'function' || typeof introspectToken !== 'function' || typeof clock !== 'function' ||
      !Array.isArray(scopes) || scopes.length < 1 || scopes.some(scope => !['recruiting.responses.read', 'recruiting.reports.read'].includes(scope)))
    throw new TypeError('connected_app_bff_ports_required');

  const inspect = async token => {
    let claims;
    try { claims = await introspectToken(token); }
    catch { throw new ConnectedAppIntrospectionUnavailable(); }
    if (claims === null || claims === undefined) throw new ConnectedAppIntrospectionUnavailable();
    if (typeof claims !== 'object' || ![true, false].includes(claims.active))
      throw new ConnectedAppIntrospectionUnavailable();
    if (claims.active === false) return null;
    const now = Math.floor(clock() / 1000);
    if (claims.iss !== issuer || claims.aud !== audience ||
        !safeId(claims.sub) || !safeId(claims.profileId) || !safeId(claims.sessionId) ||
        !Number.isSafeInteger(claims.nbf) || claims.nbf > now ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp - claims.nbf > 3600 ||
        !Array.isArray(claims.scopes) || claims.scopes.length < 1 ||
        claims.scopes.some(scope => !scopes.includes(scope))) return null;
    return claims;
  };
  const active = async req => {
    const handle = cookieValue(req, sessionCookie);
    if (!handle) return null;
    const record = await store.getSession(hash(handle));
    if (!record || !/^[a-f0-9]{64}$/.test(record.token ?? '')) return null;
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe && (req.headers.origin !== publicOrigin || !equal(req.headers['x-csrf-token'], record.csrf))) return null;
    const claims = await inspect(record.token);
    if (!claims || claims.sub !== record.sub || claims.profileId !== record.profileId ||
        claims.sessionId !== record.sessionId) return null;
    return { context: Object.freeze({ profileId: claims.profileId, scopes: Object.freeze([...new Set(claims.scopes)]) }),
      csrf: record.csrf, handle };
  };

  return {
    resolve: async req => (await active(req))?.context ?? null,
    async handle(req, res, url) {
      if (!url.pathname.startsWith('/auth/connected/')) return false;
      if (url.pathname === '/auth/connected/start' && req.method === 'GET') {
        if (url.searchParams.size !== 0) { respond(res, 400, { error: 'invalid_auth_request' }); return true; }
        const pendingHandle = random(); const state = random(); const verifier = random();
        await store.putPending(hash(pendingHandle), { state, verifier, createdAt: clock() });
        const auth = new URL(`${issuer}/v1/connected-app-sessions/authorize`);
        auth.searchParams.set('response_type', 'code');
        auth.searchParams.set('client_id', audience);
        auth.searchParams.set('redirect_uri', redirectUri);
        auth.searchParams.set('scope', scopes.join(' '));
        auth.searchParams.set('state', state);
        auth.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
        auth.searchParams.set('code_challenge_method', 'S256');
        respond(res, 303, null, { location: auth.href, 'set-cookie': cookie(pendingCookie, pendingHandle, 300, 'Lax') });
        return true;
      }
      if (url.pathname === '/auth/connected/callback' && req.method === 'GET') {
        const pendingHandle = cookieValue(req, pendingCookie);
        const transaction = pendingHandle ? await store.takePending(hash(pendingHandle)) : null;
        const entries = [...url.searchParams.keys()];
        const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
        if (!transaction || clock() - transaction.createdAt > 300_000 ||
            entries.length !== 3 || new Set(entries).size !== 3 || !entries.every(key => ['code', 'state', 'iss'].includes(key)) ||
            !/^[a-f0-9]{64}$/.test(code ?? '') || !equal(state, transaction.state) || url.searchParams.get('iss') !== issuer) {
          respond(res, 401, { error: 'invalid_auth_callback' }, { 'set-cookie': clearCookie(pendingCookie) }); return true;
        }
        let exchanged;
        try { exchanged = await exchangeCode({ code, state, verifier: transaction.verifier, redirectUri }); }
        catch { exchanged = null; }
        if (!exchanged || !/^[a-f0-9]{64}$/.test(exchanged.token ?? '') ||
            !Number.isSafeInteger(exchanged.expiresAt) || exchanged.expiresAt <= Math.floor(clock() / 1000)) {
          respond(res, 502, { error: 'token_exchange_unavailable' }, { 'set-cookie': clearCookie(pendingCookie) }); return true;
        }
        let claims;
        try { claims = await inspect(exchanged.token); }
        catch {
          respond(res, 503, { error: 'token_introspection_unavailable' }, { 'set-cookie': clearCookie(pendingCookie) }); return true;
        }
        if (!claims || claims.exp > exchanged.expiresAt) {
          respond(res, 502, { error: 'token_introspection_unavailable' }, { 'set-cookie': clearCookie(pendingCookie) }); return true;
        }
        const handle = random();
        await store.putSession(hash(handle), { token: exchanged.token, csrf: random(), createdAt: clock(),
          sub: claims.sub, profileId: claims.profileId, sessionId: claims.sessionId });
        const prior = cookieValue(req, sessionCookie);
        if (prior) await store.deleteSession(hash(prior));
        respond(res, 303, null, { location: publicOrigin, 'set-cookie': [clearCookie(pendingCookie), cookie(sessionCookie, handle, 3600)] });
        return true;
      }
      if (url.pathname === '/auth/connected/session' && req.method === 'GET') {
        const result = await active(req);
        respond(res, result ? 200 : 401, result ? { authenticated: true, profileId: result.context.profileId,
          scopes: result.context.scopes, csrfToken: result.csrf } : { authenticated: false }, { 'content-type': 'application/json; charset=utf-8' });
        return true;
      }
      if (url.pathname === '/auth/connected/logout' && req.method === 'POST') {
        const handle = cookieValue(req, sessionCookie);
        const record = handle ? await store.getSession(hash(handle)) : null;
        if (!record || req.headers.origin !== publicOrigin || !equal(req.headers['x-csrf-token'], record.csrf)) {
          respond(res, 403, { error: 'csrf_or_session_invalid' }); return true;
        }
        await store.deleteSession(hash(handle));
        respond(res, 204, null, { 'set-cookie': clearCookie(sessionCookie) });
        return true;
      }
      respond(res, 405, { error: 'method_not_allowed' });
      return true;
    },
  };
}
