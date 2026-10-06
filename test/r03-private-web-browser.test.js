import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/real-proactive.js', import.meta.url), 'utf8');
const vacancyId = 'invented_vacancy';

test('browser page uses profile cookie API, exact review revisions, idempotent manual search and polling', async () => {
  const handlers = new Map();
  const calls = [];
  const element = (id, more = {}) => ({ id, disabled: false, textContent: '', value: '',
    addEventListener: (_event, handler) => handlers.set(id, handler), ...more });
  const elements = new Map([
    ['action-status', element('action-status')], ['manual-status', element('manual-status')],
    ['schedule-status', element('schedule-status')], ['vacancy-flags-status', element('vacancy-flags-status')],
    ['interval-hours', element('interval-hours', { value: '24' })],
    ['prompt-status', element('prompt-status')], ['prompt-queries', element('prompt-queries')],
    ['prompt-save', element('prompt-save')], ['prompt-reset', element('prompt-reset')],
    ['seen-status', element('seen-status')], ['seen-ids', element('seen-ids')],
    ['seen-import', element('seen-import')],
    ['schedule-enable', element('schedule-enable')], ['schedule-disable', element('schedule-disable')],
    ...['star', 'unstar', 'archive', 'restore'].map(action => [`vacancy-${action}`, element(`vacancy-${action}`)]),
    ['manual-search', element('manual-search')]
  ]);
  const cardElements = new Map([
    ['.save-status', element('save-status')], ['.save-comment', element('save-comment')],
    ['.candidate-status', element('candidate-status', { value: 'starred' })],
    ['.candidate-comment', element('candidate-comment', { value: 'Invented note' })],
    ['.candidate-exclude', element('candidate-exclude', { checked: true })]
  ]);
  const card = { dataset: { candidateId: 'invented_resume', reviewRevision: '2' },
    querySelector: selector => cardElements.get(selector) };
  const root = { dataset: { profileId: 'invented_profile_A', vacancyId } };
  let reloads = 0;
  let replaced = '';
  let polls = 0;
  const session = new Map();
  const fetch = async (path, options = {}) => {
    calls.push({ path, options });
    let body = { ok: true };
    if (path.startsWith('/api/hh/proactive/schedule?')) body = { ok: true, schedules: [],
      flags: { starred: false, archived: false, revision: 0 } };
    if (path.startsWith('/api/hh/proactive/prompt?')) body = { ok: true, queries: ['invented query'],
      query_revision: `queries-${'a'.repeat(24)}`, override_revision: 0 };
    if (path === '/api/hh/proactive/search') body = { ok: true, run: { runId: 'invented_run' } };
    if (path.endsWith('/manual-runs/invented_run')) body = { ok: true,
      run: { status: polls++ ? 'completed' : 'running' } };
    return { ok: true, status: 200, json: async () => body };
  };
  runInNewContext(script, {
    document: { querySelector: () => root, getElementById: id => elements.get(id),
      querySelectorAll: () => [card] },
    location: { href: `https://recruiter-assistant.ru/hh/proactive?username=invented&token=old-token&vacancy_id=${vacancyId}`,
      reload: () => { reloads++; } },
    history: { replaceState: (_state, _title, path) => { replaced = path; } },
    crypto: { randomUUID: () => 'invented_idempotency_key' }, fetch, URL,
    sessionStorage: { getItem: key => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) },
    setTimeout: callback => { callback(); return 1; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replaced, `/hh/proactive?vacancy_id=${vacancyId}`);
  assert.equal(elements.get('schedule-status').textContent, 'Расписание не создано.');
  await handlers.get('vacancy-star')({ currentTarget: elements.get('vacancy-star') });
  assert.deepEqual(JSON.parse(calls.find(call => call.path === '/api/hh/proactive/vacancy-state' &&
    JSON.parse(call.options.body).action === 'star').options.body),
  { vacancy_id: vacancyId, action: 'star', expected_revision: 0 });
  for (const id of ['schedule-enable', 'schedule-disable', 'manual-search', 'save-status', 'save-comment']) {
    const button = elements.get(id) ?? cardElements.get(`.${id}`);
    await handlers.get(id)({ currentTarget: button });
  }
  const posts = calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 6);
  assert.deepEqual(JSON.parse(posts[1].options.body), { vacancy_id: vacancyId, action: 'enable', interval_hours: 24 });
  assert.deepEqual(JSON.parse(posts[2].options.body), { vacancy_id: vacancyId, action: 'disable' });
  assert.equal(posts[3].options.headers['Idempotency-Key'], 'invented_idempotency_key');
  assert.deepEqual(JSON.parse(posts[4].options.body), { vacancy_id: vacancyId, candidate_id: 'invented_resume',
    expected_revision: 2, status: 'starred' });
  assert.deepEqual(JSON.parse(posts[5].options.body), { vacancy_id: vacancyId, candidate_id: 'invented_resume',
    expected_revision: 2, comment: 'Invented note', exclude_from_search: true });
  assert.ok(calls.every(call => call.options.credentials === 'same-origin'));
  assert.ok(posts.every(call => !('token' in JSON.parse(call.options.body))));
  assert.equal(polls, 2);
  assert.equal(reloads, 3);
  assert.equal(session.size, 0);
});

test('switching signed profile on the same vacancy does not resume or reuse the first profile run', async () => {
  const previousRunKey = `r03:manual-run:invented_profile_A:${vacancyId}`;
  const session = new Map([[previousRunKey, 'run_A']]);
  const handlers = new Map();
  const elements = new Map(['action-status', 'manual-status', 'schedule-status', 'vacancy-flags-status', 'interval-hours',
    'schedule-enable', 'schedule-disable', 'manual-search', 'prompt-status', 'prompt-queries',
    'prompt-save', 'prompt-reset', 'seen-status', 'seen-ids', 'seen-import',
    'vacancy-star', 'vacancy-unstar', 'vacancy-archive', 'vacancy-restore'].map(id => [id, { id,
    value: id === 'interval-hours' ? '24' : '', textContent: '', disabled: false,
    addEventListener: (_name, handler) => handlers.set(id, handler) }]));
  const calls = [];
  const fetch = async (path, options = {}) => {
    calls.push({ path, options });
    return { ok: true, status: 200, json: async () => path.includes('/schedule?') ? { schedules: [] } :
      path.includes('/prompt?') ? { queries: ['invented query'], query_revision: `queries-${'a'.repeat(24)}`, override_revision: 0 } :
      path.endsWith('/search') ? { run: { runId: 'run_B' } } : { run: { status: 'completed' } } };
  };
  runInNewContext(script, {
    document: { querySelector: () => ({ dataset: { profileId: 'invented_profile_B', vacancyId } }),
      getElementById: id => elements.get(id), querySelectorAll: () => [] },
    location: { href: `https://recruiter-assistant.ru/hh/proactive?vacancy_id=${vacancyId}`, reload: () => {} },
    history: { replaceState: () => {} }, crypto: { randomUUID: () => 'new_key_B' },
    sessionStorage: { getItem: key => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) },
    fetch, URL, setTimeout: callback => { callback(); return 1; }
  });
  await new Promise(resolve => setImmediate(resolve));
  await handlers.get('manual-search')({ currentTarget: elements.get('manual-search') });
  assert.ok(calls.some(call => call.path === '/api/hh/proactive/search' && call.options.headers['Idempotency-Key'] === 'new_key_B'));
  assert.ok(calls.every(call => !call.path.endsWith('/run_A')));
  assert.equal(session.get(previousRunKey), 'run_A', 'other profile state remains isolated');
  assert.equal(session.has(`r03:manual-run:invented_profile_B:${vacancyId}`), false);
});

test('browser prompt editor sends target revision and uses reset tombstone without legacy token', async () => {
  const handlers = new Map();
  const elements = new Map(['action-status', 'manual-status', 'schedule-status', 'vacancy-flags-status', 'interval-hours',
    'schedule-enable', 'schedule-disable', 'manual-search', 'prompt-status', 'prompt-queries',
    'prompt-save', 'prompt-reset', 'seen-status', 'seen-ids', 'seen-import',
    'vacancy-star', 'vacancy-unstar', 'vacancy-archive', 'vacancy-restore'].map(id => [id, { id, value: '', textContent: '', disabled: false,
    addEventListener: (_name, handler) => handlers.set(id, handler) }]));
  const calls = [];
  let promptReads = 0;
  const firstRevision = `queries-${'a'.repeat(24)}`;
  const secondRevision = `queries-${'b'.repeat(24)}`;
  const fetch = async (path, options = {}) => {
    calls.push({ path, options });
    const body = path.includes('/schedule?') ? { schedules: [] } :
      path.includes('/prompt?') ? (promptReads++ ? { queries: ['regenerated'],
        query_revision: `queries-${'c'.repeat(24)}`, override_revision: 2 } :
        { queries: ['source query'], query_revision: firstRevision, override_revision: 0 }) :
      path.endsWith('/prompt') ? (calls.filter(call => call.path.endsWith('/prompt')).length === 1 ?
        { ok: true, queries: ['manual query'], query_revision: secondRevision,
          override_revision: 1, queries_manual: true } :
        { ok: true, queries_state: 'reset', pending_regeneration: true, override_revision: 2 }) :
      path.endsWith('/import-seen') ? { ok: true, imported: 2, total: 2 } : {};
    return { ok: true, status: 200, json: async () => body };
  };
  runInNewContext(script, {
    document: { querySelector: () => ({ dataset: { profileId: 'target_profile', vacancyId } }),
      getElementById: id => elements.get(id), querySelectorAll: () => [] },
    location: { href: `https://recruiter-assistant.ru/hh/proactive?vacancy_id=${vacancyId}`, reload: () => {} },
    history: { replaceState: () => {} }, crypto: { randomUUID: () => 'invented-key' },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch, URL, setTimeout: callback => { callback(); return 1; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('prompt-queries').value, 'source query');
  elements.get('prompt-queries').value = 'manual query';
  await handlers.get('prompt-save')({ currentTarget: elements.get('prompt-save') });
  await handlers.get('prompt-reset')({ currentTarget: elements.get('prompt-reset') });
  const writes = calls.filter(call => call.path === '/api/hh/proactive/prompt');
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(writes[0].options.body), { vacancy_id: vacancyId, queries: 'manual query',
    expected_revision: firstRevision, expected_override_revision: 0 });
  assert.deepEqual(JSON.parse(writes[1].options.body), { vacancy_id: vacancyId, queries: '',
    expected_revision: secondRevision, expected_override_revision: 1 });
  assert.ok(writes.every(call => !('token' in JSON.parse(call.options.body))));
  assert.equal(elements.get('prompt-queries').value, 'regenerated');
  elements.get('seen-ids').value = 'resumeA1, https://hh.ru/resume/resumeB2?from=search\nresumeA1';
  await handlers.get('seen-import')({ currentTarget: elements.get('seen-import') });
  const seenWrites = calls.filter(call => call.path === '/api/hh/proactive/import-seen');
  assert.equal(seenWrites.length, 1);
  assert.deepEqual(JSON.parse(seenWrites[0].options.body), { vacancy_id: vacancyId,
    ids: ['resumeA1', 'resumeB2'] });
  assert.match(elements.get('seen-status').textContent, /Добавлено 2/);
  elements.get('seen-ids').value = 'https://evil.example/resume/resumeX';
  await handlers.get('seen-import')({ currentTarget: elements.get('seen-import') });
  assert.equal(calls.filter(call => call.path === '/api/hh/proactive/import-seen').length, 1);
});
