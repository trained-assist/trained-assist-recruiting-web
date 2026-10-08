import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHhResponseDetailRead } from '../src/r01-live-response-detail.js';

const profileId = 'profile_A';
const vacancyId = 'vacancy_A';
const negotiationId = 'negotiation_A';
const negotiation = (vacancy = vacancyId) => ({ id: negotiationId, vacancy: { id: vacancy },
  resume: { id: 'resume_A' }, state: { id: 'response' }, updated_at: '2026-10-06T07:10:00Z' });
const result = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const ports = { userAgent: 'Recruiting Test test@example.invalid',
  loadCredential: async id => ({ profileId: id, accessToken: 'private-token' }),
  isVacancyOwned: (id, vacancy) => id === profileId && vacancy === vacancyId,
  clock: () => new Date('2026-10-06T08:00:00Z') };

test('exact HH detail returns only status after provider vacancy binding', async () => {
  const calls = [];
  const read = createHhResponseDetailRead({ ...ports, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return result(negotiation());
  } });
  const detail = await read({ profileId }, { vacancyId, negotiationId });
  assert.equal(detail.status, 200);
  const schema = JSON.parse(await readFile(new URL('../contracts/v1-live-hh-response-detail.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ formats: { 'date-time': /^\d{4}-\d\d-\d\dT/ } }).compile(schema);
  assert.equal(validate(detail.body), true, JSON.stringify(validate.errors));
  assert.deepEqual(Object.keys(detail.body).sort(), ['domainApiVersion', 'fetchedAt', 'freshness',
    'negotiationId', 'profileId', 'resumeId', 'state', 'updatedAt', 'vacancyId'].sort());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.hh.ru/negotiations/negotiation_A');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.authorization, 'Bearer private-token');
  assert.equal((await read({ profileId: 'profile_B' }, { vacancyId, negotiationId })).status, 404);
  assert.equal(calls.length, 1);
});

test('cross-vacancy and malformed provider detail fail closed; 401 refreshes once', async () => {
  const read = createHhResponseDetailRead({ ...ports, fetchImpl: async () => result(negotiation('vacancy_B')) });
  assert.equal((await read({ profileId }, { vacancyId, negotiationId })).status, 404);
  const malformed = createHhResponseDetailRead({ ...ports, fetchImpl: async () => result({ id: negotiationId }) });
  assert.equal((await malformed({ profileId }, { vacancyId, negotiationId })).status, 502);
  let calls = 0;
  const refreshed = createHhResponseDetailRead({ ...ports,
    refreshCredential: async (id, old) => { assert.equal(id, profileId); assert.equal(old, 'private-token');
      return { profileId, accessToken: 'new-token' }; },
    fetchImpl: async (_url, options) => { calls++; return options.headers.authorization === 'Bearer private-token'
      ? result(null, 401) : result(negotiation()); } });
  assert.equal((await refreshed({ profileId }, { vacancyId, negotiationId })).status, 200);
  assert.equal(calls, 2);
  const outage = createHhResponseDetailRead({ ...ports, fetchImpl: async () => { throw new Error('down'); } });
  assert.equal((await outage({ profileId }, { vacancyId, negotiationId })).status, 503);
});
