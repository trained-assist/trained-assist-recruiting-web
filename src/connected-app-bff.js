import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const audience = 'recruiting-web';
const ASSIGNMENT_COMMAND = 'recruiting.assignment.material.send';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX = /^[a-f0-9]{64}$/;
const pendingCookie = '__Host-recruiting-oauth-pending';
const sessionCookie = '__Host-recruiting-app-session';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const cpAssignmentOperation = value => ({ vacancyId: value.vacancyId, negotiationId: value.negotiationId,
  chatId: value.chatId, sourceSha256: value.sourceSha256,
  savedPlanRevisionSha256: value.savedPlanRevisionSha256, materialSha256: value.materialSha256,
  agreementMessageId: value.agreementMessageId, message: value.message });
function validAssignmentOperation(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'agreementMessageId,chatId,materialSha256,message,negotiationId,profileId,savedPlanRevisionSha256,sourceSha256,vacancyId' &&
    ['profileId', 'vacancyId', 'negotiationId', 'chatId', 'agreementMessageId'].every(key => ID.test(value[key] ?? '')) &&
    ['sourceSha256', 'savedPlanRevisionSha256', 'materialSha256'].every(key => HEX.test(value[key] ?? '')) &&
    typeof value.message === 'string' && value.message.trim().length > 0 && value.message.length <= 12_000 &&
    hash(value.message) === value.materialSha256;
}
function safeApprovalUrl(raw, intentId, issuer) {
  if (typeof raw !== 'string' || !HEX.test(intentId ?? '')) return null;
  try {
    const value = new URL(raw);
    return value.origin === issuer && value.protocol === 'https:' && !value.username && !value.password &&
      value.pathname === '/v1/connected-app-approvals/review' &&
      [...value.searchParams.keys()].join(',') === 'intent' && value.searchParams.get('intent') === intentId &&
      !value.hash ? value.href : null;
  } catch { return null; }
}
function validConsumedAssignmentReceipt(receipt, pending, current) {
  return receipt && typeof receipt === 'object' && HEX.test(receipt.receiptId ?? '') &&
    receipt.audience === audience && receipt.clientId === audience && receipt.command === ASSIGNMENT_COMMAND &&
    HEX.test(receipt.requestHash ?? '') && receipt.sourceRevision === pending.sourceRevision &&
    receipt.profileId === current.context.profileId && receipt.principalId === current.context.sub &&
    Number.isSafeInteger(receipt.approvedAt) && Number.isSafeInteger(receipt.consumedAt) &&
    stable(receipt.operation) === stable(pending.operation);
}
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export class ConnectedAppIntrospectionUnavailable extends Error {
  constructor() { super('connected_app_introspection_unavailable'); this.name = 'ConnectedAppIntrospectionUnavailable'; }
}
export class ConnectedAppApprovalUnavailable extends Error {
  constructor() { super('connected_app_approval_unavailable'); this.name = 'ConnectedAppApprovalUnavailable'; }
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
  const pending = new Map(); const sessions = new Map(); const approvals = new Map();
  return {
    async putPending(key, value) { pending.set(key, structuredClone(value)); },
    async takePending(key) { const value = pending.get(key) ?? null; pending.delete(key); return value; },
    async putSession(key, value) { sessions.set(key, structuredClone(value)); },
    async getSession(key) { return sessions.get(key) ?? null; },
    async deleteSession(key) { sessions.delete(key); },
    async putApproval(key, value) { approvals.set(key, structuredClone(value)); },
    async getApproval(key) { const value = approvals.get(key); return value ? structuredClone(value) : null; },
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
    async prepareApproval({ appToken, command, sourceRevision, operation }) {
      return approvalRequest('/prepare', { appToken, audience, command, sourceRevision, operation });
    },
    async consumeApproval({ appToken, command, sourceRevision, operation, intentId, consumerRequestId }) {
      return approvalRequest('/consume', { appToken, audience, command, sourceRevision, operation,
        intentId, consumerRequestId });
    },
  };

  async function approvalRequest(path, payload) {
    let response;
    try {
      response = await fetcher(`${issuer}/v1/connected-app-approvals${path}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(5000) });
    } catch { throw new ConnectedAppApprovalUnavailable(); }
    if (!response.ok || response.status >= 300) throw new ConnectedAppApprovalUnavailable();
    try { return await response.json(); }
    catch { throw new ConnectedAppApprovalUnavailable(); }
  }
}

/** Explicit opt-in Node BFF boundary; never constructed by the default server. */
export function createRecruitingConnectedAppBff({ issuer, allowedIssuerOrigins, publicOrigin, redirectUri, store,
  exchangeCode, introspectToken, approvalClient = null, clock = () => Date.now(),
  scopes = ['recruiting.responses.read', 'recruiting.reports.read'] } = {}) {
  if (typeof issuer !== 'string' || !issuer.startsWith('https://') || new URL(issuer).origin !== issuer ||
      !Array.isArray(allowedIssuerOrigins) || !allowedIssuerOrigins.includes(issuer) ||
      typeof publicOrigin !== 'string' || !publicOrigin.startsWith('https://') || new URL(publicOrigin).origin !== publicOrigin ||
      redirectUri !== `${publicOrigin}/auth/connected/callback` ||
      !store || !['putPending', 'takePending', 'putSession', 'getSession', 'deleteSession'].every(method => typeof store[method] === 'function') ||
      typeof exchangeCode !== 'function' || typeof introspectToken !== 'function' || typeof clock !== 'function' ||
      approvalClient !== null && (!store || !['putApproval', 'getApproval'].every(method => typeof store[method] === 'function') ||
        !['prepareApproval', 'consumeApproval'].every(method => typeof approvalClient[method] === 'function')) ||
      !Array.isArray(scopes) || scopes.length < 1 || scopes.some(scope => !['recruiting.responses.read', 'recruiting.responses.conversation.open',
        'recruiting.reports.read', 'recruiting.candidateSearch', 'recruiting.assignment.review', 'recruiting.assignment.material.send'].includes(scope)))
    throw new TypeError('connected_app_bff_ports_required');

  const allowedScopes = new Set([...scopes, 'recruiting.candidateSearch', 'recruiting.responses.read',
    'recruiting.responses.conversation.open', 'recruiting.assignment.review', 'recruiting.assignment.material.send']);
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
        claims.scopes.some(scope => !allowedScopes.has(scope))) return null;
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
        claims.sessionId !== record.sessionId ||
        !Array.isArray(record.requestedScopes) ||
        claims.scopes.some(scope => !record.requestedScopes.includes(scope)) ||
        record.requestedScopes.some(scope => !claims.scopes.includes(scope))) return null;
    return { context: Object.freeze({ profileId: claims.profileId, sub: claims.sub, scopes: Object.freeze([...new Set(claims.scopes)]) }),
      csrf: record.csrf, handle, sessionId: claims.sessionId, applicationToken: record.token };
  };

  async function prepareApprovalIntent(req, operation) {
    if (approvalClient === null) throw new ConnectedAppApprovalUnavailable();
    if (req.method !== 'POST' || req.headers.origin !== publicOrigin)
      return { status: 403, body: { error: 'csrf_or_origin_required' } };
    const current = await active(req);
    if (!current) return { status: 401, body: { error: 'connected_app_session_required' } };
    if (!current.context.scopes.includes('recruiting.assignment.material.send'))
      return { status: 403, body: { error: 'assignment_send_scope_required' } };
    if (!validAssignmentOperation(operation) || operation.profileId !== current.context.profileId)
      return { status: 400, body: { error: 'invalid_assignment_send' } };
    let prepared;
    try {
      prepared = await approvalClient.prepareApproval({ appToken: current.applicationToken,
        command: 'recruiting.assignment.material.send', sourceRevision: operation.savedPlanRevisionSha256,
        operation: cpAssignmentOperation(operation) });
    } catch { throw new ConnectedAppApprovalUnavailable(); }
    const approvalUrl = safeApprovalUrl(prepared?.approvalUrl, prepared?.intentId, issuer);
    const now = Math.floor(clock() / 1000);
    if (!approvalUrl || !Number.isSafeInteger(prepared.expiresAt) || prepared.expiresAt <= now ||
        prepared.expiresAt > now + 600) throw new ConnectedAppApprovalUnavailable();
    const handle = random();
    const consumerRequestId = randomUUID();
    await store.putApproval(hash(handle), { intentId: prepared.intentId, consumerRequestId,
      operation: cpAssignmentOperation(operation), profileId: current.context.profileId,
      principalId: current.context.sub, sessionId: current.sessionId,
      sourceRevision: operation.savedPlanRevisionSha256, expiresAt: prepared.expiresAt, receipt: null });
    return { status: 201, body: { approvalHandle: handle, approvalUrl, expiresAt: prepared.expiresAt } };
  }

  async function consumeApprovalIntent(req, handle) {
    if (approvalClient === null) throw new ConnectedAppApprovalUnavailable();
    if (req.method !== 'POST' || req.headers.origin !== publicOrigin)
      return { status: 403, body: { error: 'csrf_or_origin_required' } };
    const current = await active(req);
    if (!current) return { status: 401, body: { error: 'connected_app_session_required' } };
    if (!current.context.scopes.includes('recruiting.assignment.material.send'))
      return { status: 403, body: { error: 'assignment_send_scope_required' } };
    if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(handle))
      return { status: 400, body: { error: 'invalid_approval_handle' } };
    const pendingApproval = await store.getApproval(hash(handle));
    const now = Math.floor(clock() / 1000);
    if (!pendingApproval || pendingApproval.expiresAt <= now || pendingApproval.profileId !== current.context.profileId ||
        pendingApproval.principalId !== current.context.sub || pendingApproval.sessionId !== current.sessionId)
      return { status: 409, body: { error: 'approval_intent_unavailable' } };
    if (pendingApproval.receipt) return { status: 200, body: { receipt: pendingApproval.receipt } };
    let result;
    try {
      result = await approvalClient.consumeApproval({ appToken: current.applicationToken,
        command: 'recruiting.assignment.material.send', sourceRevision: pendingApproval.sourceRevision,
        operation: pendingApproval.operation, intentId: pendingApproval.intentId,
        consumerRequestId: pendingApproval.consumerRequestId });
    } catch { throw new ConnectedAppApprovalUnavailable(); }
    const receipt = result?.receipt;
    if (!validConsumedAssignmentReceipt(receipt, pendingApproval, current))
      throw new ConnectedAppApprovalUnavailable();
    await store.putApproval(hash(handle), { ...pendingApproval, receipt });
    return { status: 200, body: { receipt } };
  }

  return {
    resolve: async req => (await active(req))?.context ?? null,
    prepareApprovalIntent,
    consumeApprovalIntent,
    async handle(req, res, url) {
      if (!url.pathname.startsWith('/auth/connected/')) return false;
      if (url.pathname === '/auth/connected/start' && req.method === 'GET') {
        const entries = [...url.searchParams.keys()];
        if (entries.length === 0) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
          res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Рекрутинг</title><main><h1>Выберите раздел</h1><ul><li><a href="/auth/connected/start?from=proactive">Холодный поиск</a></li><li><a href="/auth/connected/start?from=responses">Отклики HH</a></li><li><a href="/auth/connected/start?from=assignment">Проверка материалов вакансии</a></li></ul></main></html>');
          return true;
        }
        const from = url.searchParams.get('from');
        const fromProactive = from === 'proactive';
        const fromResponses = from === 'responses';
        const fromAssignment = from === 'assignment';
        const fromAssignmentSend = from === 'assignment-send';
        const fromConversation = from === 'conversation';
        const vacancyId = url.searchParams.get('vacancy_id');
        const negotiationId = url.searchParams.get('negotiation_id');
        if (new Set(entries).size !== entries.length ||
            (entries.length !== 0 && (!(fromProactive || fromResponses || fromAssignment || fromAssignmentSend || fromConversation) ||
              entries.some(key => !['from', 'vacancy_id', 'negotiation_id'].includes(key)) ||
              vacancyId !== null && !safeId(vacancyId) || negotiationId !== null && !safeId(negotiationId) ||
              (fromAssignmentSend || fromConversation) && (!vacancyId || !negotiationId) ||
              !fromAssignmentSend && !fromConversation && negotiationId !== null))) {
          respond(res, 400, { error: 'invalid_auth_request' }); return true;
        }
        const returnPath = fromConversation
          ? `/hh/conversation?vacancy_id=${encodeURIComponent(vacancyId)}&negotiation_id=${encodeURIComponent(negotiationId)}`
          : fromAssignmentSend
          ? `/hh/assignment/send?vacancy_id=${encodeURIComponent(vacancyId)}&negotiation_id=${encodeURIComponent(negotiationId)}`
          : `${fromAssignment ? '/hh/assignment' : fromResponses ? '/hh/responses' : '/hh/proactive'}${vacancyId ? `?vacancy_id=${encodeURIComponent(vacancyId)}` : ''}`;
        const requestedScopes = fromConversation
          ? ['recruiting.responses.conversation.open']
          : fromAssignmentSend
          ? ['recruiting.assignment.material.send', 'recruiting.responses.conversation.open']
          : fromAssignment ? ['recruiting.assignment.review'] : fromResponses ? ['recruiting.responses.read'] : ['recruiting.candidateSearch'];
        const pendingHandle = random(); const state = random(); const verifier = random();
        await store.putPending(hash(pendingHandle), { state, verifier, returnPath, requestedScopes, createdAt: clock() });
        const auth = new URL(`${issuer}/v1/connected-app-sessions/authorize`);
        auth.searchParams.set('response_type', 'code');
        auth.searchParams.set('client_id', audience);
        auth.searchParams.set('redirect_uri', redirectUri);
        auth.searchParams.set('scope', requestedScopes.join(' '));
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
        const returnPath = transaction?.returnPath ?? '/hh/proactive';
        if (!transaction || clock() < transaction.createdAt || clock() - transaction.createdAt > 300_000 ||
            !/^\/hh\/(?:proactive|responses|assignment)(?:\?vacancy_id=[A-Za-z0-9_-]{1,128})?$/.test(returnPath) &&
              !/^\/hh\/(?:assignment\/send|conversation)\?vacancy_id=[A-Za-z0-9_-]{1,128}&negotiation_id=[A-Za-z0-9_-]{1,128}$/.test(returnPath) ||
            !Array.isArray(transaction?.requestedScopes) || transaction.requestedScopes.length < 1 ||
            transaction.requestedScopes.some(scope => !allowedScopes.has(scope)) ||
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
        if (transaction.requestedScopes.some(scope => !claims.scopes.includes(scope)) ||
            claims.scopes.some(scope => !transaction.requestedScopes.includes(scope))) {
          respond(res, 403, { error: 'connected_app_scope_denied' },
            { 'set-cookie': clearCookie(pendingCookie) }); return true;
        }
        const handle = random();
        await store.putSession(hash(handle), { token: exchanged.token, csrf: random(), createdAt: clock(),
          expiresAt: claims.exp * 1000,
          sub: claims.sub, profileId: claims.profileId, sessionId: claims.sessionId,
          requestedScopes: transaction.requestedScopes });
        const prior = cookieValue(req, sessionCookie);
        if (prior) await store.deleteSession(hash(prior));
        respond(res, 303, null, { location: `${publicOrigin}${returnPath}`,
          'set-cookie': [clearCookie(pendingCookie), cookie(sessionCookie, handle, 3600)] });
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
