import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('manifest, capabilities, and readiness expose a versioned read-only contract', async () => {
  const manifest = await (await get('/api/v1/manifest')).json();
  assert.equal(manifest.apiVersion, 'v1');
  assert.equal(manifest.service, 'recruiting');
  assert.deepEqual(manifest.capabilities, ['vacancies.read']);
  assert.equal((await (await get('/api/v1/capabilities')).json()).apiVersion, 'v1');
  assert.equal((await (await get('/api/v1/readiness')).json()).status, 'ready');
  assert.equal((await get('/health/ready')).status, 200);
});

test('vacancies match the published schema and contain synthetic data only', async () => {
  const response = await get('/api/v1/vacancies');
  const payload = await response.json();
  const schema = JSON.parse(await readFile(new URL('contracts/v1-vacancies.schema.json', root), 'utf8'));
  assert.equal(response.status, 200);
  assert.equal(payload.apiVersion, 'v1');
  assert.ok(payload.items.length > 0);
  assert.equal(schema.properties.apiVersion.const, payload.apiVersion);
  for (const item of payload.items) {
    assert.match(item.id, /^vac_demo_\d{3}$/);
    assert.equal(item.status, 'open');
    assert.deepEqual(Object.keys(item).sort(), ['employmentType', 'id', 'location', 'status', 'summary', 'title'].sort());
  }
});

test('browser landing page is useful and all writes are rejected', async () => {
  const page = await get('/');
  assert.match(await page.text(), /Recruiting API demo/);
  assert.equal((await fetch(`${base}/api/v1/vacancies`, { method: 'POST' })).status, 405);
});

test('unknown paths return 404', async () => {
  assert.equal((await get('/unknown')).status, 404);
});
