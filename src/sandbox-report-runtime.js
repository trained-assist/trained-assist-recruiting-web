import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRecruitingConnectedAppBff } from './connected-app-bff.js';
import { createRecruitingServer } from './server.js';
import { SqliteAcceptedReportDraftStore } from './sqlite-accepted-report-draft-store.js';
import { createHhResponseRead } from './r01-live-responses.js';
import { createHhResponseDetailRead } from './r01-live-response-detail.js';
import { createHhResponseConversationRead } from './r01-live-response-conversation.js';
import { SqliteResponseConversationAudit } from './sqlite-response-conversation-audit.js';

export const sandboxReportFixture = Object.freeze({
  candidateId: 'candidate_search_demo_001',
  vacancyId: 'vac_demo_001',
});
export const sandboxResponseFixture = Object.freeze({
  negotiationId: 'negotiation_demo_001',
  chatId: 'chat_demo_001',
  resumeId: 'resume_demo_001',
});

const reportScopes = Object.freeze([
  'recruiting.reports.read', 'recruiting.reports.create',
  'recruiting.reports.edit', 'recruiting.reports.review',
]);
const candidateSearchScope = 'recruiting.candidateSearch';
const demoProfileId = 'profile_demo_001';
const demoVacancyId = 'vac_demo_001';
const responseProfileId = 'profile_sandbox_responses_001';
const responseVacancyId = 'vacancy_responses_demo_001';
const responseReadScopes = Object.freeze(['recruiting.responses.read']);
const responseConversationScopes = Object.freeze([
  'recruiting.responses.read', 'recruiting.responses.conversation.open',
]);
const reportFields = Object.freeze({
  candidateName: 'Синтетический кандидат',
  position: 'Инженер Node.js',
  vacancyTitle: 'Synthetic Node.js engineer',
  experience: [{ role: 'Инженер', company: 'Вымышленная компания', period: '2021 — 2025' }],
  education: ['Вымышленный университет, 2020'],
  courses: ['Учебный курс, 2022'],
  skills: ['TypeScript', 'API design'],
  languages: ['English — C1'],
  location: 'Тестовый регион',
});
const sourceRevision = createHash('sha256').update(JSON.stringify(reportFields)).digest('hex');
const clockSeconds = () => Math.floor(Date.now() / 1000);

function createBoundedSandboxBffStore() {
  const pending = new Map();
  const sessions = new Map();
  return {
    async putPending(key, value) {
      const cutoff = Date.now() - 300_000;
      for (const [id, record] of pending) if (record.createdAt < cutoff) pending.delete(id);
      if (!pending.has(key) && pending.size >= 500) throw new Error('sandbox_auth_capacity');
      pending.set(key, structuredClone(value));
    },
    async takePending(key) { const value = pending.get(key) ?? null; pending.delete(key); return value; },
    async putSession(key, value) {
      const now = Date.now();
      for (const [id, record] of sessions) if (record.expiresAt <= now) sessions.delete(id);
      if (!sessions.has(key) && sessions.size >= 500) throw new Error('sandbox_auth_capacity');
      sessions.set(key, structuredClone(value));
    },
    async getSession(key) {
      const record = sessions.get(key);
      if (record?.expiresAt <= Date.now()) { sessions.delete(key); return null; }
      return record ?? null;
    },
    async deleteSession(key) { sessions.delete(key); },
  };
}

function syntheticClaims(profileId, expiresAt, scopes) {
  const now = clockSeconds();
  return { active: true, iss: null, aud: 'recruiting-web', sub: `actor_${profileId}`,
    profileId, sessionId: `session_${profileId}`, nbf: expiresAt - 300, exp: expiresAt,
    scopes: [...scopes] };
}

function createSyntheticIdentity({ publicOrigin, store, issuedProfiles }) {
  const bff = createRecruitingConnectedAppBff({ issuer: publicOrigin,
    allowedIssuerOrigins: [publicOrigin], publicOrigin,
    redirectUri: `${publicOrigin}/auth/connected/callback`, store,
    scopes: [...reportScopes, candidateSearchScope, ...responseReadScopes, ...responseConversationScopes],
    exchangeCode: async ({ code, state, verifier, redirectUri }) => {
      const issued = issuedProfiles.get(code);
      if (!issued || issued.state !== state || issued.used ||
          redirectUri !== `${publicOrigin}/auth/connected/callback` ||
          createHash('sha256').update(verifier).digest('base64url') !== issued.challenge) return null;
      if (issued.profileId === responseProfileId && issued.exchanged) return null;
      issued.used = true;
      if (issued.profileId === responseProfileId) issued.exchanged = true;
      issued.expiresAt = clockSeconds() + 300;
      return { token: code, expiresAt: issued.expiresAt };
    },
    introspectToken: async token => {
      const issued = issuedProfiles.get(token);
      if (!issued?.used || issued.expiresAt <= clockSeconds()) return { active: false };
      const claims = syntheticClaims(issued.profileId, issued.expiresAt, issued.scopes);
      claims.iss = publicOrigin;
      return claims;
    },
  });
  return { bff, async authorize(req, res, url) {
    if (url.pathname !== '/v1/connected-app-sessions/authorize' || req.method !== 'GET') return false;
    const params = url.searchParams;
    const scope = params.get('scope');
    const redirectUri = params.get('redirect_uri');
    const state = params.get('state');
    const challenge = params.get('code_challenge');
    if ([...params.keys()].length !== 7 || params.get('response_type') !== 'code' ||
        params.get('client_id') !== 'recruiting-web' ||
        redirectUri !== `${publicOrigin}/auth/connected/callback` ||
        ![reportScopes.join(' '), candidateSearchScope, responseReadScopes.join(' '),
          responseConversationScopes.join(' ')].includes(scope) ||
        params.get('code_challenge_method') !== 'S256' ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(state ?? '') ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge ?? '')) {
      res.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      res.end('synthetic authorization request denied');
      return true;
    }
    for (const [id, entry] of issuedProfiles) if (entry.expiresAt <= clockSeconds()) issuedProfiles.delete(id);
    if (issuedProfiles.size >= 500) {
      res.writeHead(429, { 'cache-control': 'no-store', 'retry-after': '60' });
      res.end();
      return true;
    }
    const code = randomBytes(32).toString('hex');
    const scopes = scope === candidateSearchScope ? [candidateSearchScope] :
      scope === responseReadScopes.join(' ') ? [...responseReadScopes] :
        scope === responseConversationScopes.join(' ') ? [...responseConversationScopes] : [...reportScopes];
    const profileId = scope === candidateSearchScope ? demoProfileId :
      scope === responseReadScopes.join(' ') || scope === responseConversationScopes.join(' ') ? responseProfileId :
        `profile_sandbox_report_${randomBytes(20).toString('hex')}`;
    issuedProfiles.set(code, { profileId, scopes, state, challenge, used: false, expiresAt: clockSeconds() + 300 });
    const callback = new URL('/auth/connected/callback', publicOrigin);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', state);
    callback.searchParams.set('iss', publicOrigin);
    res.writeHead(303, { location: callback.href, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end();
    return true;
  } };
}

function createSyntheticHhTransport() {
  const metrics = { listReads: 0, detailReads: 0, conversationHistoryReads: 0, foreignEgress: 0 };
  const vacancyId = responseVacancyId;
  const negotiationId = sandboxResponseFixture.negotiationId;
  const chatId = sandboxResponseFixture.chatId;
  const resumeId = sandboxResponseFixture.resumeId;
  const createdAt = '2026-10-08T09:00:00.000Z';
  const conversationText = 'Синтетическое сообщение для проверки Recruiting Web.';

  return {
    metrics,
    async fetch(input, options = {}) {
      const url = new URL(input);
      if (url.origin !== 'https://api.hh.ru') {
        metrics.foreignEgress++;
        throw new Error('sandbox_hh_transport_rejected_foreign_egress');
      }
      if (options.method !== 'GET' || options.headers?.authorization !== 'Bearer synthetic-hh-response-token' ||
          options.headers?.['HH-User-Agent'] !== 'Recruiting sandbox sandbox@example.invalid')
        return Response.json({ error: 'synthetic_hh_auth_rejected' }, { status: 401 });

      if (url.pathname === '/negotiations/response' && url.searchParams.get('vacancy_id') === vacancyId &&
          url.searchParams.get('per_page') === '20' && url.searchParams.get('page') === '0') {
        metrics.listReads++;
        return Response.json({ found: 1, pages: 1, page: 0, items: [{
          id: negotiationId, state: { id: 'response' }, vacancy: { id: vacancyId },
          resume: { id: resumeId, first_name: 'Синтетический', last_name: 'Кандидат', title: 'Synthetic engineer' },
          created_at: createdAt, updated_at: createdAt,
        }] });
      }
      if (url.pathname === `/negotiations/${negotiationId}`) {
        metrics.detailReads++;
        return Response.json({ id: negotiationId, vacancy: { id: vacancyId }, chat_id: chatId,
          resume: { id: resumeId }, state: { id: 'response' }, updated_at: createdAt });
      }
      if (url.pathname === `/common/chats/${chatId}/messages` && url.searchParams.get('order') === 'prev' &&
          url.searchParams.get('limit') === '50') {
        metrics.conversationHistoryReads++;
        return Response.json({ id: chatId, vacancy_id: vacancyId, has_more: false, messages: [{
          id: 'message_demo_001', creation_time: createdAt, type: 'SIMPLE', viewed_by_opponent: false,
          payload: { text: conversationText },
        }] });
      }
      return Response.json({ error: 'synthetic_hh_resource_not_found' }, { status: 404 });
    },
  };
}

export function createSandboxReportRuntime({ publicOrigin, reportDraftsDbPath, encryptionKey } = {}) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new TypeError('sandbox_report_configuration_required'); }
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password ||
      !/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev$/.test(publicOrigin) ||
      typeof reportDraftsDbPath !== 'string' || !reportDraftsDbPath.startsWith('/') ||
      resolve(reportDraftsDbPath) !== reportDraftsDbPath ||
      typeof encryptionKey !== 'string' || !/^[a-f0-9]{64}$/i.test(encryptionKey))
    throw new TypeError('sandbox_report_configuration_required');

  const profileFor = profileId => /^profile_sandbox_report_[a-f0-9]{40}$/.test(profileId);
  const draftStore = new SqliteAcceptedReportDraftStore({ filename: reportDraftsDbPath, encryptionKey });
  const sourceRead = async (context, request) => {
    if (!context || !profileFor(context.profileId) || request?.candidateId !== sandboxReportFixture.candidateId ||
        request?.vacancyId !== sandboxReportFixture.vacancyId ||
        (request?.sourceKind ?? 'accepted_cold_search') !== 'accepted_cold_search')
      return { status: 404, body: { error: 'not_found' } };
    return { status: 200, body: {
      domainApiVersion: 'v1', profileId: context.profileId,
      vacancyId: sandboxReportFixture.vacancyId, candidateId: sandboxReportFixture.candidateId,
      sourceRevision, sourceKind: 'accepted_cold_search', publication: 'disabled',
      clientDraftFields: structuredClone(reportFields),
    } };
  };
  const issuedProfiles = new Map();
  const hhTransport = createSyntheticHhTransport();
  const identity = createSyntheticIdentity({ publicOrigin, store: createBoundedSandboxBffStore(), issuedProfiles });
  const conversationAudit = new SqliteResponseConversationAudit({ filename: reportDraftsDbPath });
  const responseCredential = async profileId => profileId === responseProfileId
    ? { profileId, accessToken: 'synthetic-hh-response-token' } : null;
  const responseOwnership = (profileId, vacancyId) => profileId === responseProfileId && vacancyId === responseVacancyId;
  const liveResponseRead = createHhResponseRead({ loadCredential: responseCredential,
    refreshCredential: responseCredential, fetchImpl: hhTransport.fetch,
    isVacancyOwned: responseOwnership, userAgent: 'Recruiting sandbox sandbox@example.invalid' });
  const liveResponseDetailRead = createHhResponseDetailRead({ loadCredential: responseCredential,
    refreshCredential: responseCredential, fetchImpl: hhTransport.fetch,
    isVacancyOwned: responseOwnership, userAgent: 'Recruiting sandbox sandbox@example.invalid' });
  const liveResponseConversationRead = createHhResponseConversationRead({ loadCredential: responseCredential,
    refreshCredential: responseCredential, fetchImpl: hhTransport.fetch,
    isVacancyOwned: responseOwnership, userAgent: 'Recruiting sandbox sandbox@example.invalid',
    conversationAudit });
  const app = createRecruitingServer({ connectedAppBff: identity.bff,
    liveResponseRead, liveResponseDetailRead, liveResponseConversationRead,
    acceptedReportSourceRead: sourceRead, acceptedReportDraftStore: draftStore,
    sandboxSyntheticReportLink: true,
    resolveCurrentSearchCriteriaRevision: (_context, vacancyId) =>
      vacancyId === demoVacancyId ? 'criteria-search-demo-r1' : null,
    resolveScheduledSearchRequest: async (profileId, vacancyId) => profileId === demoProfileId && vacancyId === demoVacancyId
      ? { vacancyId, criteriaRevision: 'criteria-search-demo-r1',
        criteria: { keywords: ['synthetic engineer'], regions: ['region_demo_001'] } }
      : null,
  });
  const server = createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, publicOrigin); } catch {
      res.writeHead(400, { 'cache-control': 'no-store' }); res.end(); return;
    }
    if (url.pathname === '/__sandbox-login') {
      if (req.method !== 'GET' || url.search !== '') {
        res.writeHead(400, { 'cache-control': 'no-store' }); res.end(); return;
      }
      res.writeHead(303, { location: `/auth/connected/start?from=proactive&vacancy_id=${demoVacancyId}`,
        'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
      res.end();
      return;
    }
    if (url.pathname === '/__sandbox/tick') {
      const keys = [...url.searchParams.keys()];
      const vacancyId = url.searchParams.get('vacancy_id');
      if (req.method !== 'GET' || keys.length !== 1 || keys[0] !== 'vacancy_id' || vacancyId !== demoVacancyId) {
        res.writeHead(400, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
        res.end(JSON.stringify({ error: 'invalid_sandbox_tick_request' }));
        return;
      }
      let context = null;
      try { context = await identity.bff.resolve(req); } catch { /* Deny below. */ }
      if (context?.profileId !== demoProfileId || !context.scopes.includes(candidateSearchScope)) {
        res.writeHead(403, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
        res.end(JSON.stringify({ error: 'sandbox_profile_denied' }));
        return;
      }
      const schedules = app.coldSearchScheduleRepository.listSchedules(demoProfileId);
      const schedule = schedules.find(row => row.vacancyId === demoVacancyId && row.enabled);
      if (!schedule) {
        res.writeHead(409, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
        res.end(JSON.stringify({ error: 'sandbox_schedule_not_enabled' }));
        return;
      }
      app.coldSearchScheduleRepository.upsertSchedule({ ...schedule,
        nextRunAt: new Date(Date.now() - 60_000).toISOString() });
      const result = await app.coldSearchSchedules.tick('sandbox-http-trigger');
      const status = result.completed === 1 ? 200 : result.unknown ? 503 : 409;
      res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' });
      res.end(JSON.stringify({ outcome: result.completed === 1 ? 'synthetic_tick' : 'not_completed', ...result }));
      return;
    }
    identity.authorize(req, res, url).then(handled => {
      if (!handled) app.emit('request', req, res);
    }).catch(() => {
      if (!res.headersSent) res.writeHead(503, { 'cache-control': 'no-store' });
      res.end();
    });
  });
  server.sandboxResponseMetrics = () => structuredClone(hhTransport.metrics);
  server.on('close', () => { draftStore.close(); conversationAudit.close(); issuedProfiles.clear(); });
  return server;
}

export async function ensureSandboxReportState(directory) {
  if (typeof directory !== 'string' || !directory.startsWith('/') || resolve(directory) !== directory)
    throw new TypeError('sandbox_report_state_directory_required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privateDirectory = await realpath(directory);
  const info = await stat(privateDirectory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new TypeError('sandbox_report_state_directory_required');
  const keyPath = `${privateDirectory}/report-drafts.key`;
  let key;
  try { key = (await readFile(keyPath, 'utf8')).trim(); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    key = randomBytes(32).toString('hex');
    let handle;
    try {
      handle = await open(keyPath, 'wx', 0o600);
      await handle.writeFile(`${key}\n`, 'utf8');
      await handle.sync();
    } catch (writeError) {
      if (writeError?.code !== 'EEXIST') throw writeError;
      key = (await readFile(keyPath, 'utf8')).trim();
    } finally { await handle?.close(); }
  }
  const keyInfo = await lstat(keyPath);
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || (keyInfo.mode & 0o077) !== 0 ||
      !/^[a-f0-9]{64}$/i.test(key))
    throw new TypeError('sandbox_report_key_unavailable');
  return { key, databasePath: `${privateDirectory}/report-drafts.sqlite` };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const originIndex = args.indexOf('--public-origin');
  const stateIndex = args.indexOf('--state-directory');
  if (args.length !== 6 || portIndex < 0 || originIndex < 0 || stateIndex < 0 ||
      portIndex % 2 || originIndex % 2 || stateIndex % 2) {
    process.stderr.write('sandbox report runtime requires --port, --public-origin, and --state-directory\n');
    process.exitCode = 64;
  } else {
    const port = Number(args[portIndex + 1]);
    try {
      const state = await ensureSandboxReportState(args[stateIndex + 1]);
      const server = createSandboxReportRuntime({ publicOrigin: args[originIndex + 1],
        reportDraftsDbPath: state.databasePath, encryptionKey: state.key });
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
      server.listen(port, '127.0.0.1', () => process.stdout.write(
        `${JSON.stringify({ event: 'sandbox.report_runtime', status: 'listening', bind: 'loopback', port })}\n`));
    } catch {
      process.stderr.write('sandbox report runtime unavailable\n');
      process.exitCode = 78;
    }
  }
}
