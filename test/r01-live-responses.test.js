import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHhResponseRead } from '../src/r01-live-responses.js';
import { createRecruitingServer } from '../src/server.js';

const profileId = 'profile_demo_001';
const vacancyId = 'vac_demo_001';
const item = (id, vacancy = vacancyId) => ({ id, state: { id: 'response' }, vacancy: { id: vacancy },
  created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-02T09:00:00Z',
  resume: { id: `resume_${id}`, first_name: 'Test', last_name: 'Applicant', title: 'Engineer' } });
const reply = (items = [item('n1')], status = 200) => ({ status, ok: status >= 200 && status < 300,
  json: async () => ({ items, found: items.length, pages: 1, page: 0 }) });

test('HH read uses trusted profile credential and vacancy, projects a typed live page', async () => {
  const calls = [];
  const read = createHhResponseRead({ userAgent: 'Recruiting Test test@example.invalid',
    loadCredential: async id => ({ profileId: id, accessToken: 'private-token' }),
    isVacancyOwned: (id, vacancy) => id === profileId && vacancy === vacancyId,
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return reply(); },
    clock: () => new Date('2026-10-06T07:00:00Z') });
  const result = await read({ profileId }, { vacancyId });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/negotiations/response');
  assert.equal(new URL(calls[0].url).searchParams.get('vacancy_id'), vacancyId);
  assert.equal(calls[0].options.headers.authorization, 'Bearer private-token');
  assert.equal(calls[0].options.headers['HH-User-Agent'], 'Recruiting Test test@example.invalid');
  assert.equal(result.body.items[0].id, 'n1');
  assert.equal(result.body.paginationConsistency, 'best_effort');
  assert.equal(JSON.stringify(result.body).includes('private-token'), false);
  const schema = JSON.parse(await readFile(new URL('../contracts/v1-live-hh-response-page.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ formats: { 'date-time': /^\d{4}-\d\d-\d\dT/ } }).compile(schema);
  assert.equal(validate(result.body), true, JSON.stringify(validate.errors));
  assert.equal((await read({ profileId: 'profile_demo_002' }, { vacancyId })).status, 404);
  assert.equal(calls.length, 1);
});

test('HH failures and malformed or cross-vacancy pages fail closed; 401 refreshes once', async () => {
  const port = { userAgent: 'Recruiting Test test@example.invalid',
    loadCredential: async () => ({ profileId, accessToken: 'old' }),
    isVacancyOwned: () => true, fetchImpl: async () => reply() };
  for (const bad of [reply([item('n1'), item('n1')]), reply([item('n1', 'other')]),
    { status: 200, ok: true, json: async () => ({ items: [], found: 0, pages: 1, page: 1 }) }]) {
    const read = createHhResponseRead({ ...port, fetchImpl: async () => bad });
    assert.deepEqual(await read({ profileId }, { vacancyId }), { status: 502, body: { error: 'hh_invalid_response' } });
  }
  let calls = 0;
  const read = createHhResponseRead({ ...port,
    refreshCredential: async (id, previous) => { assert.equal(id, profileId); assert.equal(previous, 'old'); return { profileId, accessToken: 'new' }; },
    fetchImpl: async (_url, options) => { calls++; return options.headers.authorization === 'Bearer old' ? reply([], 401) : reply(); } });
  assert.equal((await read({ profileId }, { vacancyId })).status, 200);
  assert.equal(calls, 2);
  const denied = createHhResponseRead({ ...port, fetchImpl: async () => reply([], 403) });
  assert.deepEqual(await denied({ profileId }, { vacancyId }), { status: 503, body: { error: 'hh_authorization_required' } });
});

test('HTTP route requires trusted profile scope and never reads another vacancy', async t => {
  let calls = 0;
  const read = createHhResponseRead({ userAgent: 'Recruiting Test test@example.invalid',
    loadCredential: async () => ({ profileId, accessToken: 'secret' }),
    isVacancyOwned: (id, vacancy) => id === profileId && vacancy === vacancyId,
    fetchImpl: async () => { calls++; return reply(); } });
  const server = createRecruitingServer({ liveResponseRead: read,
    resolveTrustedProfileContext: req => req.headers['x-test-principal'] === 'owner' ?
      { profileId, scopes: ['recruiting.responses.read'] } : req.headers['x-test-principal'] === 'noscope' ?
      { profileId, scopes: [] } : null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/ui/hh-responses`;
  assert.equal((await fetch(`${base}?vacancyId=${vacancyId}`)).status, 401);
  assert.equal((await fetch(`${base}?vacancyId=${vacancyId}`, { headers: { 'x-test-principal': 'noscope' } })).status, 403);
  assert.equal((await fetch(`${base}?vacancyId=other`, { headers: { 'x-test-principal': 'owner' } })).status, 404);
  assert.equal((await fetch(`${base}?vacancyId=${vacancyId}&state=discard`, { headers: { 'x-test-principal': 'owner' } })).status, 400);
  assert.equal(calls, 0);
  const response = await fetch(`${base}?vacancyId=${vacancyId}`, { headers: { 'x-test-principal': 'owner' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items[0].resumeId, 'resume_n1');
  assert.equal(calls, 1);
  assert.equal((await fetch(`${base}?vacancyId=${vacancyId}`, { method: 'POST', headers: { 'x-test-principal': 'owner' } })).status, 405);
});
