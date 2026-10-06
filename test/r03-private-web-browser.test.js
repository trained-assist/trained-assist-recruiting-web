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
    ['schedule-status', element('schedule-status')], ['interval-hours', element('interval-hours', { value: '24' })],
    ['schedule-enable', element('schedule-enable')], ['schedule-disable', element('schedule-disable')],
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
  const root = { dataset: { vacancyId } };
  let reloads = 0;
  let replaced = '';
  let polls = 0;
  const session = new Map();
  const fetch = async (path, options = {}) => {
    calls.push({ path, options });
    let body = { ok: true };
    if (path.startsWith('/api/hh/proactive/schedule?')) body = { ok: true, schedules: [] };
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
  for (const id of ['schedule-enable', 'schedule-disable', 'manual-search', 'save-status', 'save-comment']) {
    const button = elements.get(id) ?? cardElements.get(`.${id}`);
    await handlers.get(id)({ currentTarget: button });
  }
  const posts = calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 5);
  assert.deepEqual(JSON.parse(posts[0].options.body), { vacancy_id: vacancyId, action: 'enable', interval_hours: 24 });
  assert.deepEqual(JSON.parse(posts[1].options.body), { vacancy_id: vacancyId, action: 'disable' });
  assert.equal(posts[2].options.headers['Idempotency-Key'], 'invented_idempotency_key');
  assert.deepEqual(JSON.parse(posts[3].options.body), { vacancy_id: vacancyId, candidate_id: 'invented_resume',
    expected_revision: 2, status: 'starred' });
  assert.deepEqual(JSON.parse(posts[4].options.body), { vacancy_id: vacancyId, candidate_id: 'invented_resume',
    expected_revision: 2, comment: 'Invented note', exclude_from_search: true });
  assert.ok(calls.every(call => call.options.credentials === 'same-origin'));
  assert.ok(posts.every(call => !('token' in JSON.parse(call.options.body))));
  assert.equal(polls, 2);
  assert.equal(reloads, 3);
  assert.equal(session.size, 0);
});
