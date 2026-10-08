import test from 'node:test';
import assert from 'node:assert/strict';
import { createHhResponseResumeRead } from '../src/r01-live-response-resume.js';

const profileId = 'profile_synthetic_owner';
const vacancyId = 'vacancy_synthetic_owned';
const resumeId = 'resume_synthetic_001';
const userAgent = 'synthetic-recruiting/1.0 (support@example.test)';
const atsConfig = { vacancy_title: 'Synthetic Engineer', filters: { min_experience_years: 0 }, required: [], preferred: [] };
const raw = { id: resumeId, title: 'Synthetic Platform Engineer', first_name: 'Синтетический', last_name: 'Кандидат',
  total_experience: { months: 60 }, area: { name: 'Тестовый регион' }, salary: { amount: 100000, currency: 'RUR' },
  email: 'private@example.test', alternate_url: 'https://hh.ru/resume/private',
  education: { primary: [{ name: 'Вымышленный вуз', organization: 'Учебный центр', year: 2020 }],
    additional: [{ name: 'Вымышленный курс' }] }, skill_set: [{ name: 'TypeScript' }],
  language: [{ name: 'Русский', level: { name: 'Родной' } }],
  experience: [{ position: 'Инженер', company: 'Тестовая компания', start: '2020', end: null }] };

test('response resume reader uses exact owned resume endpoint and returns only mapped private source fields', async () => {
  const calls = [];
  const read = createHhResponseResumeRead({
    loadCredential: async id => ({ profileId: id, accessToken: 'synthetic-token' }),
    refreshCredential: async () => { throw new Error('unexpected_refresh'); },
    loadBasePlan: async (id, vacancy, options) => ({ profileId: id, vacancyId: vacancy,
      criteriaRevision: 'criteria-synthetic-r1', atsConfig, options }),
    isVacancyOwned: (id, vacancy) => id === profileId && vacancy === vacancyId,
    userAgent,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => raw };
    },
  });
  const result = await read({ profileId, scopes: ['recruiting.reports.read'] }, { vacancyId, resumeId });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.hh.ru/resumes/${resumeId}`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers['HH-User-Agent'], userAgent);
  assert.equal(result.body.resume.title, raw.title);
  assert.deepEqual(result.body.resume.education, ['Вымышленный вуз, Учебный центр, 2020']);
  assert.deepEqual(result.body.resume.courses, ['Вымышленный курс']);
  assert.deepEqual(result.body.resume.skills, ['TypeScript']);
  assert.deepEqual(result.body.resume.languages, ['Русский — Родной']);
  assert.equal(result.body.resume.location, 'Тестовый регион');
  assert.equal(result.body.candidateProjection.id, resumeId);
  assert.equal(result.body.candidateProjection.salary.amount, 100000);
  assert.equal(JSON.stringify(result.body).includes('private@example.test'), false);
  assert.equal(JSON.stringify(result.body).includes('alternate_url'), false);
  assert.match(result.body.sourceRevision, /^[a-f0-9]{64}$/);
});

test('response resume reader fails closed before HH for missing scope, foreign profile or changed plan', async () => {
  let credentialCalls = 0, hhCalls = 0;
  const read = createHhResponseResumeRead({
    loadCredential: async id => { credentialCalls++; return { profileId: id, accessToken: 'synthetic-token' }; },
    refreshCredential: async () => null,
    loadBasePlan: async (id, vacancy) => ({ profileId: id, vacancyId: vacancy,
      criteriaRevision: 'criteria-synthetic-r1', atsConfig }),
    isVacancyOwned: (id, vacancy) => id === profileId && vacancy === vacancyId,
    userAgent,
    fetchImpl: async () => { hhCalls++; throw new Error('unexpected_hh_request'); },
  });
  assert.equal((await read({ profileId, scopes: [] }, { vacancyId, resumeId })).status, 404);
  assert.equal((await read({ profileId: 'profile_foreign', scopes: ['recruiting.reports.read'] },
    { vacancyId, resumeId })).status, 404);
  assert.equal(credentialCalls, 0);
  assert.equal(hhCalls, 0);
});

test('response resume reader refreshes once and rejects provider identity mismatch', async () => {
  let requests = 0, refreshes = 0;
  const read = createHhResponseResumeRead({
    loadCredential: async id => ({ profileId: id, accessToken: 'expired-token' }),
    refreshCredential: async id => { refreshes++; return { profileId: id, accessToken: 'fresh-token' }; },
    loadBasePlan: async (id, vacancy) => ({ profileId: id, vacancyId: vacancy,
      criteriaRevision: 'criteria-synthetic-r1', atsConfig }),
    isVacancyOwned: (id, vacancy) => id === profileId && vacancy === vacancyId,
    userAgent,
    fetchImpl: async (_url, options) => {
      requests++;
      if (requests === 1) return { status: 401, ok: false, json: async () => ({}) };
      assert.equal(options.headers.Authorization, 'Bearer fresh-token');
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ ...raw, id: 'foreign_resume' }) };
    },
  });
  const result = await read({ profileId, scopes: ['recruiting.reports.read'] }, { vacancyId, resumeId });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'hh_resume_invalid');
  assert.equal(requests, 2);
  assert.equal(refreshes, 1);
});
