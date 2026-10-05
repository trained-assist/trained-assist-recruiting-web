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

test('browser landing page is useful and all writes are rejected', async () => {
  const page = await get('/');
  assert.match(await page.text(), /Recruiting API demo/);
  assert.equal((await fetch(`${base}/api/v1/vacancies`, { method: 'POST' })).status, 405);
});

test('unknown paths return 404', async () => {
  assert.equal((await get('/unknown')).status, 404);
});
