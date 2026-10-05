import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createRecruitingServer } from '../src/server.js';

const root = new URL('../', import.meta.url);
let server;
let base;
test.before(async () => {
  server = createRecruitingServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

async function get(path) { return fetch(`${base}${path}`); }
async function loadSchema(name) {
  return JSON.parse(await readFile(new URL(`contracts/${name}`, root), 'utf8'));
}

test('manifest, capabilities, and readiness expose a versioned read-only contract', async () => {
  const manifest = await (await get('/api/v1/manifest')).json();
  const schema = await loadSchema('v1-manifest.schema.json');
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(manifest.serviceId, 'trained-assist.recruiting');
  assert.equal(manifest.release.environment, 'local');
  assert.equal(manifest.readiness.status, 'ready');
  assert.match(manifest.readiness.reason.message, /local synthetic-fixture use only/);
  assert.deepEqual(manifest.capabilities[0], {
    id: 'recruiting.vacancies.list',
    version: '1.0.0',
    required: true,
    inputSchemaRef: 'contracts/v1-vacancies-query.schema.json',
    outputSchemaRef: 'contracts/v1-vacancies.schema.json',
    effect: 'read',
    requiredScopes: [],
    operationRef: 'GET /api/v1/vacancies'
  });
  assert.deepEqual(schema.properties.readiness.properties.status.enum, ['ready', 'degraded', 'blocked', 'unavailable']);
  assert.deepEqual(manifest.capabilities.map(({ id }) => id), ['recruiting.vacancies.list']);
  assert.deepEqual(Object.keys(manifest.endpoints), ['manifest', 'capabilities', 'readiness', 'vacancies']);
  const capabilities = await (await get('/api/v1/capabilities')).json();
  assert.deepEqual(capabilities.capabilities, manifest.capabilities);
  const readiness = await (await get('/api/v1/readiness')).json();
  assert.equal(readiness.status, 'ready');
  assert.deepEqual(readiness.checkedVersionTuple, manifest.readiness.checkedVersionTuple);
  assert.equal((await get('/health/ready')).status, 200);
  const invalidManifest = { ...manifest, platformContractRange: '*' };
  assert.equal(validate(invalidManifest), false);
});

test('vacancies match the published schema and contain synthetic data only', async () => {
  const response = await get('/api/v1/vacancies');
  const payload = await response.json();
  const schema = await loadSchema('v1-vacancies.schema.json');
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  assert.equal(response.status, 200);
  assert.equal(validate(payload), true, JSON.stringify(validate.errors));
  assert.ok(payload.items.length > 0);
  assert.equal(validate({ ...payload, items: [{ ...payload.items[0], candidateEmail: 'person@example.com' }] }), false);
  const queryResponse = await get('/api/v1/vacancies?unexpected=value');
  assert.equal(queryResponse.status, 400);
  assert.deepEqual(await queryResponse.json(), { error: 'unexpected_query_parameters' });
});

test('local UI fixture routes enforce synthetic profile checks and paginate revision-bound response reads', async () => {
  const profileId = 'profile_demo_001';
  const vacancyId = 'vac_demo_001';
  const vacanciesInput = await loadSchema('v1-profile-vacancies-input.schema.json');
  const vacanciesOutput = await loadSchema('v1-profile-vacancies.schema.json');
  const responsesInput = await loadSchema('v1-vacancy-responses-input.schema.json');
  const responsesOutput = await loadSchema('v1-vacancy-responses.schema.json');
  const ajv = new Ajv2020({ allErrors: true });
  const validateVacanciesInput = ajv.compile(vacanciesInput);
  const validateVacanciesOutput = ajv.compile(vacanciesOutput);
  const validateResponsesInput = ajv.compile(responsesInput);
  const validateResponsesOutput = ajv.compile(responsesOutput);

  assert.equal(validateVacanciesInput({ profileId }), true);
  assert.equal(validateResponsesInput({ profileId, vacancyId }), true);
  assert.equal(validateResponsesInput({ profileId, vacancyId, limit: 1 }), true);
  assert.equal(validateResponsesInput({ profileId, vacancyId, applicantEmail: 'person@example.com' }), false);

  const url = `/api/v1/profiles/${profileId}/vacancies`;
  assert.equal((await get(url)).status, 401);
  assert.equal((await fetch(`${base}${url}`, { headers: { 'X-Demo-Profile-Id': 'profile_demo_002' } })).status, 403);

  const vacanciesResponse = await fetch(`${base}${url}`, { headers: { 'X-Demo-Profile-Id': profileId } });
  const vacanciesPayload = await vacanciesResponse.json();
  assert.equal(vacanciesResponse.status, 200);
  assert.equal(validateVacanciesOutput(vacanciesPayload), true, JSON.stringify(validateVacanciesOutput.errors));
  assert.deepEqual(vacanciesPayload.items.map(item => item.id), [vacancyId]);

  const responsesUrl = `/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?limit=1`;
  const responsesResponse = await fetch(`${base}${responsesUrl}`, { headers: { 'X-Demo-Profile-Id': profileId } });
  const responsesPayload = await responsesResponse.json();
  assert.equal(responsesResponse.status, 200);
  assert.equal(validateResponsesOutput(responsesPayload), true, JSON.stringify(validateResponsesOutput.errors));
  assert.equal(responsesPayload.freshness, 'current');
  assert.equal(responsesPayload.revision, 'responses-demo-001-r1');
  assert.equal(responsesPayload.items.length, 1);
  assert.ok(responsesPayload.nextCursor);
  assert.equal(validateResponsesInput({ profileId, vacancyId, limit: 1, cursor: responsesPayload.nextCursor }), true);

  const nextPageUrl = `/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?limit=1&cursor=${encodeURIComponent(responsesPayload.nextCursor)}`;
  const nextPageResponse = await fetch(`${base}${nextPageUrl}`, { headers: { 'X-Demo-Profile-Id': profileId } });
  const nextPagePayload = await nextPageResponse.json();
  assert.equal(nextPageResponse.status, 200);
  assert.equal(validateResponsesOutput(nextPagePayload), true, JSON.stringify(validateResponsesOutput.errors));
  assert.equal(nextPagePayload.revision, responsesPayload.revision);
  assert.equal(nextPagePayload.freshness, 'current');
  assert.equal(nextPagePayload.items[0].id, 'response_demo_002');
  assert.equal(nextPagePayload.nextCursor, null);

  const staleCursor = Buffer.from(JSON.stringify({ profileId, vacancyId, revision: 'responses-demo-001-r0', offset: 1 })).toString('base64url');
  const staleResponse = await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?cursor=${staleCursor}`, { headers: { 'X-Demo-Profile-Id': profileId } });
  const stalePayload = await staleResponse.json();
  assert.equal(staleResponse.status, 409);
  assert.equal(validateResponsesOutput(stalePayload), true, JSON.stringify(validateResponsesOutput.errors));
  assert.equal(stalePayload.freshness, 'stale');
  assert.equal(stalePayload.currentRevision, responsesPayload.revision);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?limit=0`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?cursor=`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?cursor=%%%`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?unexpected=x`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses`, { method: 'POST', headers: { 'X-Demo-Profile-Id': profileId } })).status, 405);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/vac_demo_002/responses`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 404);
  const insufficientScope = await fetch(`${base}/api/v1/profiles/profile_demo_002/vacancies/vac_demo_002/responses`, { headers: { 'X-Demo-Profile-Id': 'profile_demo_002' } });
  assert.equal(insufficientScope.status, 403);
  assert.deepEqual(await insufficientScope.json(), { error: 'demo_scope_required' });
});

test('client report preview is synthetic, audience-scoped, escaped, pair-checked, and never publishes', async () => {
  const sources = JSON.parse(await readFile(new URL('data/report-scenarios.json', root), 'utf8'));
  const sourceSchema = await loadSchema('v1-report-source-internal.schema.json');
  const querySchema = await loadSchema('v1-report-preview-query.schema.json');
  const previewSchema = await loadSchema('v1-client-report-preview.schema.json');
  const ajv = new Ajv2020({ allErrors: true });
  const validateSource = ajv.compile(sourceSchema);
  const validateQuery = ajv.compile(querySchema);
  const validatePreview = ajv.compile(previewSchema);
  const source = sources[0];
  const query = { candidateId: source.candidateId, vacancyId: source.vacancyId };
  assert.equal(validateSource(source), true, JSON.stringify(validateSource.errors));
  assert.equal(validateQuery(query), true);
  assert.equal(validateQuery({ ...query, audience: 'internal' }), false);
  assert.equal(validateSource({ ...source, audience: 'client' }), false);

  const fixtureBefore = await readFile(new URL('data/report-scenarios.json', root));
  const previewUrl = `/api/v1/ui/report-previews?candidateId=${query.candidateId}&vacancyId=${query.vacancyId}`;
  const response = await get(previewUrl);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(validatePreview(payload), true, JSON.stringify(validatePreview.errors));
  assert.equal(payload.mode, 'preview');
  assert.equal(payload.audience, 'client');
  assert.equal(payload.previewOnly, true);
  assert.equal(payload.publication, 'disabled');
  assert.equal(payload.sourceRevision, source.sourceRevision);
  assert.equal(validatePreview({ ...payload, clientView: { ...payload.clientView, internalNotes: 'not allowed' } }), false);
  assert.match(payload.html, new RegExp(`report-source-revision" content="${source.sourceRevision}`));
  assert.match(payload.html, /СИНТЕТИЧЕСКИЙ ЧЕРНОВИК · НЕ ДЛЯ ОТПРАВКИ/);
  assert.match(payload.html, /&lt;script&gt;alert\(&quot;synthetic&quot;\)&lt;\/script&gt; &amp; reliable APIs\./);
  assert.equal(payload.html.includes('<script>alert("synthetic")</script>'), false);
  const internalMarkers = Object.values(source.internal).flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value : []);
  for (const marker of internalMarkers) {
    assert.equal(payload.html.includes(marker), false, `internal marker leaked: ${marker}`);
    assert.equal(JSON.stringify(payload.clientView).includes(marker), false, `internal marker leaked into client view: ${marker}`);
  }
  assert.equal(Object.hasOwn(payload, 'internal'), false);
  assert.equal((await (await get(previewUrl)).json()).html, payload.html, 'renderer output is deterministic');

  const mismatch = await get(`/api/v1/ui/report-previews?candidateId=${query.candidateId}&vacancyId=vac_demo_002`);
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await mismatch.json(), { error: 'candidate_vacancy_mismatch' });
  assert.equal((await get('/api/v1/ui/report-previews?candidateId=candidate_demo_999&vacancyId=vac_demo_001')).status, 404);
  assert.equal((await get('/api/v1/ui/report-previews?candidateId=candidate_demo_001&vacancyId=vac_demo_001&audience=internal')).status, 400);
  assert.equal((await fetch(`${base}${previewUrl}`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/v1/ui/report-publish`, { method: 'POST' })).status, 405);
  assert.equal((await get('/api/v1/ui/report-publish')).status, 404);
  assert.deepEqual(await readFile(new URL('data/report-scenarios.json', root)), fixtureBefore);
});

test('browser landing page is useful and all writes are rejected', async () => {
  const page = await get('/');
  const html = await page.text();
  assert.match(html, /Recruiting API demo/);
  assert.match(html, /Select a vacancy/);
  assert.match(html, /Read-only responses/);
  assert.match(html, /not agent capabilities/);
  assert.match(html, /Load more responses/);
  assert.match(html, /Client report draft preview/);
  assert.match(html, /not saved, published, or shared/);
  assert.match(html, /not production authentication/);
  assert.equal((await fetch(`${base}/api/v1/vacancies`, { method: 'POST' })).status, 405);
});

test('unknown paths return 404', async () => {
  assert.equal((await get('/unknown')).status, 404);
});
