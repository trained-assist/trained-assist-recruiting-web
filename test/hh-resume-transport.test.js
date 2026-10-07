import test from 'node:test';
import assert from 'node:assert/strict';
import { createHhResumeTransport, HhSearchError, resolveHhSearchAreas } from '../src/hh-resume-transport.js';

const trustedContext = { profileId: 'profile_001', scopes: ['recruiting.candidateSearch'] };
const vacancyId = 'vacancy_001';
const response = (status, body = { items: [{ id: 'synthetic_resume_001' }], found: 1, pages: 1 }) => ({
  status, ok: status >= 200 && status < 300, json: async () => body
});
const fixture = (overrides = {}) => {
  const calls = [];
  const fetchImpl = overrides.fetchImpl ?? (async (url, init) => { calls.push({ url, init }); return response(200); });
  const transport = createHhResumeTransport({
    loadVacancyContext: overrides.loadVacancyContext ?? (async (profileId, id) => ({ profileId, vacancyId: id, config: { vacancy_id: id, filters: { area: [{ id: 1 }, { id: 2 }, { id: 1 }] } }, vacancy: { area: { id: 9 } } })),
    loadCredential: overrides.loadCredential ?? (async profileId => ({ profileId, accessToken: 'fake-access-token' })),
    refreshCredential: overrides.refreshCredential,
    fetchImpl, sleep: overrides.sleep ?? (async () => {})
  });
  return { transport, calls };
};
const search = transport => transport.search({ trustedContext, vacancyId, query: 'synthetic analyst' });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof HhSearchError && error.code === code);

test('explicit area precedence, unrestricted null, dedupe, and fixed HH page size', async () => {
  assert.deepEqual(resolveHhSearchAreas({ filters: { area: [1, { id: 2 }, 1] } }, { area: 9 }), ['1', '2']);
  assert.deepEqual(resolveHhSearchAreas({ filters: { area: 1 } }, { area: 9 }, { area: null }), []);
  assert.deepEqual(resolveHhSearchAreas({}, { area: { id: '77' } }), ['77']);
  assert.throws(() => resolveHhSearchAreas({}, {}), { code: 'area_missing' });
  assert.throws(() => resolveHhSearchAreas({ area: 'Moscow' }, {}), { code: 'area_invalid' });
  const { transport, calls } = fixture();
  const result = await search(transport);
  assert.deepEqual(result.areas, ['1', '2']);
  assert.equal(result.profileId, trustedContext.profileId);
  assert.equal(result.vacancyId, vacancyId);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://api.hh.ru/resumes');
  assert.equal(url.searchParams.get('text'), 'synthetic analyst');
  assert.equal(url.searchParams.get('page'), '0');
  assert.equal(url.searchParams.get('per_page'), '50');
  assert.equal(url.searchParams.get('order_by'), 'relevance');
  assert.deepEqual(url.searchParams.getAll('area'), ['1', '2']);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fake-access-token');
  await transport.search({ trustedContext, vacancyId, query: 'synthetic analyst', area: null });
  assert.deepEqual(new URL(calls[1].url).searchParams.getAll('area'), []);
});

test('missing profile, vacancy binding, token or geography fails before fetch', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return response(200); };
  const normal = fixture({ fetchImpl }).transport;
  await rejectsCode(normal.search({ vacancyId, query: 'synthetic analyst' }), 'profile_denied');
  await rejectsCode(normal.search({ trustedContext: { profileId: 'profile_001', scopes: [] }, vacancyId, query: 'synthetic analyst' }), 'profile_denied');
  await rejectsCode(normal.search({ trustedContext, vacancyId: '../bad', query: 'synthetic analyst' }), 'vacancy_invalid');
  await rejectsCode(search(fixture({ fetchImpl, loadVacancyContext: async () => ({ profileId: 'another', vacancyId, config: { area: 1 } }) }).transport), 'vacancy_context_unavailable');
  await rejectsCode(search(fixture({ fetchImpl, loadVacancyContext: async () => ({ profileId: 'profile_001', vacancyId, config: { vacancy_id: 'other', area: 1 } }) }).transport), 'vacancy_context_unavailable');
  await rejectsCode(search(fixture({ fetchImpl, loadVacancyContext: async () => { throw new Error('candidate name secret'); } }).transport), 'vacancy_context_unavailable');
  await rejectsCode(search(fixture({ fetchImpl, loadVacancyContext: async profileId => ({ profileId, vacancyId, config: {} }) }).transport), 'area_missing');
  await rejectsCode(search(fixture({ fetchImpl, loadCredential: async () => null }).transport), 'credential_unavailable');
  await rejectsCode(search(fixture({ fetchImpl, loadCredential: async () => ({ profileId: 'other', accessToken: 'secret' }) }).transport), 'credential_unavailable');
  await rejectsCode(search(fixture({ fetchImpl, loadCredential: async () => { throw new Error('token secret'); } }).transport), 'credential_unavailable');
  assert.equal(fetches, 0);
  assert.throws(() => createHhResumeTransport({ loadVacancyContext: () => ({}), loadCredential: () => ({}) }), /explicit fetch adapter required/);
});

test('429 and 5xx retry twice with bounded exponential waits; terminal errors stay typed', async () => {
  for (const status of [429, 500, 503]) {
    let fetches = 0;
    const waits = [];
    const { transport } = fixture({ fetchImpl: async () => { fetches++; return response(fetches < 3 ? status : 200); }, sleep: async ms => waits.push(ms) });
    assert.equal((await search(transport)).items.length, 1);
    assert.equal(fetches, 3);
    assert.deepEqual(waits, [500, 1000]);
    const failed = fixture({ fetchImpl: async () => response(status), sleep: async ms => waits.push(ms) });
    await rejectsCode(search(failed.transport), 'provider_unavailable');
  }
});

test('reads every HH page, with page-local retry and no partial return', async () => {
  const requested = [];
  let secondPageAttempts = 0;
  const { transport } = fixture({ fetchImpl: async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    requested.push(page);
    if (page === 1 && secondPageAttempts++ === 0) return response(503);
    return response(200, { items: [{ id: `synthetic_resume_${page}` }], found: 3, pages: 3 });
  } });
  const result = await search(transport);
  assert.deepEqual(requested, [0, 1, 1, 2]);
  assert.deepEqual(result.items.map(item => item.id), ['synthetic_resume_0', 'synthetic_resume_1', 'synthetic_resume_2']);
  assert.equal(result.pages, 3);
  await rejectsCode(search(fixture({ fetchImpl: async url => response(200, {
    items: [{ id: 'synthetic_resume' }], pages: Number(new URL(url).searchParams.get('page')) === 0 ? 2 : 3
  }) }).transport), 'provider_page_count_changed');
  await rejectsCode(search(fixture({ fetchImpl: async () => response(200, {
    items: [], pages: 41
  }) }).transport), 'provider_result_window_exceeded');
});

test('401/403 refresh once and retry; missing or wrong-profile refresh fails closed', async () => {
  for (const status of [401, 403]) {
    const auth = [];
    const refreshes = [];
    const { transport } = fixture({
      fetchImpl: async (_url, init) => { auth.push(init.headers.Authorization); return response(auth.length === 1 ? status : 200); },
      refreshCredential: async (profileId, old) => { refreshes.push([profileId, old]); return { profileId, accessToken: 'fake-rotated-token' }; }
    });
    await search(transport);
    assert.deepEqual(auth, ['Bearer fake-access-token', 'Bearer fake-rotated-token']);
    assert.deepEqual(refreshes, [['profile_001', 'fake-access-token']]);
    let calls = 0;
    const repeated = fixture({ fetchImpl: async () => { calls++; return response(status); }, refreshCredential: async profileId => ({ profileId, accessToken: 'fake-rotated-token' }) });
    await rejectsCode(search(repeated.transport), status === 401 ? 'provider_unauthorized' : 'provider_forbidden');
    assert.equal(calls, 2);
    await rejectsCode(search(fixture({ fetchImpl: async () => response(status), refreshCredential: async () => ({ profileId: 'other', accessToken: 'secret' }) }).transport), 'credential_unavailable');
  }
});

test('provider payload and errors do not leak into error messages or logs', async () => {
  const pii = 'PRIVATE_CANDIDATE_NAME';
  const logs = [];
  const original = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...parts) => logs.push(parts.join(' '));
  try {
    const invalid = fixture({ fetchImpl: async () => response(200, { items: Array(51).fill({ name: pii }) }) });
    await rejectsCode(search(invalid.transport), 'provider_invalid_response');
    await rejectsCode(search(fixture({ fetchImpl: async () => null }).transport), 'provider_invalid_response');
    const failed = fixture({ fetchImpl: async () => { throw new Error(pii); } });
    await rejectsCode(search(failed.transport), 'provider_unavailable');
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(pii));
  } finally { [console.log, console.warn, console.error] = original; }
});
