import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getProfile, listProfileVacancies, profileHasScope, readVacancyResponses } from './recruiting-domain.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const vacancies = JSON.parse(await readFile(join(root, 'data/vacancies.json'), 'utf8'));
const landingPage = await readFile(join(root, 'public/index.html'), 'utf8');
const release = {
  version: '0.1.0',
  sourceRevision: process.env.SOURCE_REVISION ?? 'unversioned-local',
  environment: 'local'
};
const platformContractRange = '>=1.0.0 <2.0.0';
const readiness = {
  status: 'ready',
  reason: {
    code: 'synthetic_fixture_service',
    message: 'Ready for local synthetic-fixture use only; no production data or integrations are connected.'
  },
  checkedVersionTuple: {
    releaseVersion: release.version,
    sourceRevision: release.sourceRevision,
    environment: release.environment,
    platformContractRange,
    domainApiVersion: 'v1'
  }
};
const capabilities = [{
  id: 'recruiting.vacancies.list',
  version: '1.0.0',
  required: true,
  inputSchemaRef: 'contracts/v1-vacancies-query.schema.json',
  outputSchemaRef: 'contracts/v1-vacancies.schema.json',
  effect: 'read',
  requiredScopes: [],
  operationRef: 'GET /api/v1/vacancies'
}];
const manifest = {
  serviceId: 'trained-assist.recruiting',
  release,
  platformContractRange,
  domainApiVersion: 'v1',
  capabilities,
  readiness,
  compatibility: { deprecatedCapabilities: [] },
  endpoints: {
    manifest: '/api/v1/manifest',
    capabilities: '/api/v1/capabilities',
    readiness: '/api/v1/readiness',
    vacancies: '/api/v1/vacancies'
  }
};
const mime = { json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8' };

function parseResponsePageOptions(url) {
  const params = url.searchParams;
  const keys = [...params.keys()];
  if (keys.some(key => !['limit', 'cursor'].includes(key)) || new Set(keys).size !== keys.length) {
    return { error: 'unexpected_query_parameters' };
  }
  const rawLimit = params.get('limit');
  if (rawLimit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) return { error: 'invalid_page_request' };
  return { limit: rawLimit === null ? 25 : Number(rawLimit), cursor: params.get('cursor') };
}

export function createRecruitingServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    let status = 200;
    let type = mime.json;
    let body;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      status = 405;
      body = { error: 'method_not_allowed' };
      res.setHeader('Allow', 'GET, HEAD');
    } else if (path === '/') {
      type = mime.html;
      body = landingPage;
    } else if (path === '/health/ready') {
      body = { status: 'ready' };
    } else if (path === '/api/v1/readiness') {
      body = { serviceId: manifest.serviceId, domainApiVersion: manifest.domainApiVersion, ...readiness };
    } else if (path === '/api/v1/manifest') {
      body = manifest;
    } else if (path === '/api/v1/capabilities') {
      body = { serviceId: manifest.serviceId, domainApiVersion: manifest.domainApiVersion, capabilities };
    } else if (path === '/api/v1/vacancies') {
      if (url.search !== '') {
        status = 400;
        body = { error: 'unexpected_query_parameters' };
      } else {
        body = { apiVersion: 'v1', items: vacancies };
      }
    } else {
      const responseRoute = path.match(/^\/api\/v1\/profiles\/([^/]+)\/vacancies\/([^/]+)\/responses$/);
      const vacancyRoute = path.match(/^\/api\/v1\/profiles\/([^/]+)\/vacancies$/);
      const route = responseRoute ?? vacancyRoute;
      if (route) {
        const profileId = route[1];
        const demoProfileId = req.headers['x-demo-profile-id'];
        if (typeof demoProfileId !== 'string') {
          status = 401;
          body = { error: 'demo_profile_required' };
        } else if (demoProfileId !== profileId) {
          status = 403;
          body = { error: 'demo_profile_mismatch' };
        } else if (!getProfile(profileId)) {
          status = 404;
          body = { error: 'not_found' };
        } else if (!profileHasScope(profileId, responseRoute ? 'recruiting.responses.read' : 'recruiting.profile.read')) {
          status = 403;
          body = { error: 'demo_scope_required' };
        } else if (responseRoute) {
          const [, , vacancyId] = responseRoute;
          const pageOptions = parseResponsePageOptions(url);
          if (pageOptions.error) {
            status = 400;
            body = { error: pageOptions.error };
          } else {
            const page = readVacancyResponses(profileId, vacancyId, pageOptions);
            if (page === null) {
              status = 404;
              body = { error: 'not_found' };
            } else if (page.kind === 'invalid_cursor') {
              status = 400;
              body = { error: 'invalid_cursor' };
            } else if (page.kind === 'stale_cursor') {
              status = 409;
              body = {
                domainApiVersion: 'v1',
                profileId,
                vacancyId,
                freshness: 'stale',
                error: 'stale_cursor',
                requestedRevision: page.requestedRevision,
                currentRevision: page.currentRevision
              };
            } else {
              body = {
                domainApiVersion: 'v1',
                profileId,
                vacancyId,
                revision: page.revision,
                freshness: page.freshness,
                items: page.items,
                nextCursor: page.nextCursor
              };
            }
          }
        } else if (url.search !== '') {
          status = 400;
          body = { error: 'unexpected_query_parameters' };
        } else {
          const items = listProfileVacancies(profileId);
          if (items === null) {
            status = 404;
            body = { error: 'not_found' };
          } else {
            body = { domainApiVersion: 'v1', profileId, items };
          }
        }
      } else {
        status = 404;
        body = { error: 'not_found' };
      }
    }

    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  createRecruitingServer().listen(port, '127.0.0.1', () => {
    console.log(`Recruiting demo listening on http://127.0.0.1:${port}`);
  });
}
