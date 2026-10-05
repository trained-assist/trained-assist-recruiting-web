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
  const profileCapabilities = manifest.capabilities.filter(capability => capability.id.startsWith('recruiting.profile.'));
  assert.deepEqual(profileCapabilities.map(({ id, requiredScopes }) => [id, requiredScopes]), [
    ['recruiting.profile.vacancies.list', ['recruiting.profile.read']],
    ['recruiting.profile.vacancy-responses.list', ['recruiting.responses.read']]
  ]);
  for (const capability of profileCapabilities) {
    ajv.compile(await loadSchema(capability.inputSchemaRef.replace(/^contracts\//, '')));
    ajv.compile(await loadSchema(capability.outputSchemaRef.replace(/^contracts\//, '')));
  }
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

test('profile-scoped vacancy selection and response reads enforce the synthetic principal and declared scopes', async () => {
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
  assert.equal(validateResponsesInput({ profileId, vacancyId, applicantEmail: 'person@example.com' }), false);

  const url = `/api/v1/profiles/${profileId}/vacancies`;
  assert.equal((await get(url)).status, 401);
  assert.equal((await fetch(`${base}${url}`, { headers: { 'X-Demo-Profile-Id': 'profile_demo_002' } })).status, 403);

  const vacanciesResponse = await fetch(`${base}${url}`, { headers: { 'X-Demo-Profile-Id': profileId } });
  const vacanciesPayload = await vacanciesResponse.json();
  assert.equal(vacanciesResponse.status, 200);
  assert.equal(validateVacanciesOutput(vacanciesPayload), true, JSON.stringify(validateVacanciesOutput.errors));
  assert.deepEqual(vacanciesPayload.items.map(item => item.id), [vacancyId]);

  const responsesUrl = `/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses`;
  const responsesResponse = await fetch(`${base}${responsesUrl}`, { headers: { 'X-Demo-Profile-Id': profileId } });
  const responsesPayload = await responsesResponse.json();
  assert.equal(responsesResponse.status, 200);
  assert.equal(validateResponsesOutput(responsesPayload), true, JSON.stringify(validateResponsesOutput.errors));
  assert.equal(responsesPayload.items.length, 2);
  assert.equal((await fetch(`${base}${responsesUrl}`, { method: 'POST', headers: { 'X-Demo-Profile-Id': profileId } })).status, 405);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/vac_demo_002/responses`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 404);
  const insufficientScope = await fetch(`${base}/api/v1/profiles/profile_demo_002/vacancies/vac_demo_002/responses`, { headers: { 'X-Demo-Profile-Id': 'profile_demo_002' } });
  assert.equal(insufficientScope.status, 403);
  assert.deepEqual(await insufficientScope.json(), { error: 'demo_scope_required' });
});

test('browser landing page is useful and all writes are rejected', async () => {
  const page = await get('/');
  const html = await page.text();
  assert.match(html, /Recruiting API demo/);
  assert.match(html, /Select a vacancy/);
  assert.match(html, /Read-only responses/);
  assert.match(html, /not production authentication/);
  assert.equal((await fetch(`${base}/api/v1/vacancies`, { method: 'POST' })).status, 405);
});

test('unknown paths return 404', async () => {
  assert.equal((await get('/unknown')).status, 404);
});
