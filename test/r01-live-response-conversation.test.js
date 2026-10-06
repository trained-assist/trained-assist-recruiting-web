import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHhResponseConversationRead } from '../src/r01-live-response-conversation.js';

const profileId = 'profile_A', vacancyId = 'vacancy_A', negotiationId = 'negotiation_A', chatId = 'chat_A';
const detail = (overrides = {}) => ({ id: negotiationId, vacancy: { id: vacancyId }, chat_id: 123456, ...overrides });
const messages = Array.from({ length: 3 }, (_, index) => ({ id: `message_${index}`, creation_time: `2026-10-06T07:0${index}:00Z`,
  last_change_time: null, can_edit: false, sender_participant_id: `participant_${index}`, sender_display_info: {},
  type: 'SIMPLE', payload: { text: `<message ${index}>` }, viewed_by_opponent: false }));
const page = (overrides = {}) => ({ id: String(123456), vacancy_id: vacancyId,
  messages, has_more: false, chat_states: { write_message_state: { allowed: true }, send_file_state: { allowed: false } }, ...overrides });
const result = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const ports = { userAgent: 'Recruiting Test test@example.invalid',
  loadCredential: async id => ({ profileId: id, accessToken: 'private-token' }),
  isVacancyOwned: (id, vacancy) => id === profileId && vacancy === vacancyId,
  clock: () => new Date('2026-10-06T08:00:00Z') };

test('explicit conversation read binds negotiation/chat/vacancy, fetches one bounded page and validates public schema', async () => {
  const calls = [];
  const read = createHhResponseConversationRead({ ...ports, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return calls.length === 1 ? result(detail()) : result(page());
  } });
  const response = await read({ profileId }, { vacancyId, negotiationId });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const schema = JSON.parse(await readFile(new URL('../contracts/v1-live-hh-response-conversation.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ formats: { 'date-time': /^\d{4}-\d\d-\d\dT/ } }).compile(schema);
  assert.equal(validate(response.body), true, JSON.stringify(validate.errors));
  assert.equal(response.body.messages[0].text, '<message 0>');
  assert.equal(response.body.viewedEffect, 'may_mark_response_viewed');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.href, 'https://api.hh.ru/negotiations/negotiation_A');
  assert.equal(calls[1].url.pathname, '/common/chats/123456/messages');
  assert.equal(calls[1].url.searchParams.get('order'), 'prev');
  assert.equal(calls[1].url.searchParams.get('limit'), '50');
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.headers['HH-User-Agent'] === ports.userAgent));
  assert.equal((await read({ profileId: 'profile_B' }, { vacancyId, negotiationId })).status, 404);
  assert.equal(calls.length, 2);
});

test('foreign negotiation, missing chat, malformed/incompatible chat page fail before content is returned', async () => {
  let calls = 0;
  const foreign = createHhResponseConversationRead({ ...ports, fetchImpl: async () => { calls++; return result(detail({ vacancy: { id: 'vacancy_B' } })); } });
  assert.equal((await foreign({ profileId }, { vacancyId, negotiationId })).status, 404);
  assert.equal(calls, 1);
  const noChat = createHhResponseConversationRead({ ...ports, fetchImpl: async () => { calls++; return result(detail({ chat_id: null })); } });
  assert.equal((await noChat({ profileId }, { vacancyId, negotiationId })).status, 409);
  assert.equal(calls, 2, 'no chat request occurs when exact negotiation has no chat binding');
  for (const bad of [page({ vacancy_id: 'vacancy_B' }), page({ has_more: 'yes' }),
    page({ messages: [{ ...messages[0], payload: { text: 'a', attachments: [] } }] })]) {
    const read = createHhResponseConversationRead({ ...ports, fetchImpl: async url =>
      new URL(url).pathname.startsWith('/negotiations/') ? result(detail()) : result(bad) });
    assert.equal((await read({ profileId }, { vacancyId, negotiationId })).status, 502);
  }
});

test('attachment projection excludes provider URLs from public message data', async () => {
  const attachmentPage = page({ messages: [{ ...messages[0], payload: { attachments: [{
    url: 'https://private.example/signed?token=secret', title: 'CV.pdf', content_type: 'application/pdf' }] } }] });
  const read = createHhResponseConversationRead({ ...ports, fetchImpl: async url =>
    new URL(url).pathname.startsWith('/negotiations/') ? result(detail()) : result(attachmentPage) });
  const response = await read({ profileId }, { vacancyId, negotiationId });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.messages[0].attachments, [{ title: 'CV.pdf', contentType: 'application/pdf' }]);
  assert.doesNotMatch(JSON.stringify(response.body), /private\.example|token=secret/);
});

test('401 refresh is bounded and chat/history provider errors do not leak payload text', async () => {
  let calls = 0;
  const read = createHhResponseConversationRead({ ...ports,
    refreshCredential: async id => ({ profileId: id, accessToken: 'renewed-token' }),
    fetchImpl: async url => { calls++;
      if (calls === 1) return result(null, 401);
      return new URL(url).pathname.startsWith('/negotiations/') ? result(detail()) : result(page());
    } });
  assert.equal((await read({ profileId }, { vacancyId, negotiationId })).status, 200);
  assert.equal(calls, 3);
  const down = createHhResponseConversationRead({ ...ports, fetchImpl: async url =>
    new URL(url).pathname.startsWith('/negotiations/') ? result(detail()) : result({ error: 'PRIVATE_MESSAGE' }, 500) });
  assert.deepEqual((await down({ profileId }, { vacancyId, negotiationId })).body, { error: 'hh_provider_unavailable' });
});

test('audit is durable before chat GET, records outcome, and fails closed', async () => {
  const events = [];
  let calls = 0;
  const read = createHhResponseConversationRead({ ...ports, createAttemptId: () => 'attempt_1',
    conversationAudit: { start: async event => events.push(['start', event]),
      finish: async event => events.push(['finish', event]) },
    fetchImpl: async url => { calls++;
      if (new URL(url).pathname.startsWith('/negotiations/')) return result(detail());
      assert.deepEqual(events.map(event => event[0]), ['start']);
      return result(page());
    } });
  assert.equal((await read({ profileId }, { vacancyId, negotiationId })).status, 200);
  assert.deepEqual(events.map(event => event[0]), ['start', 'finish']);
  assert.equal(events[0][1].chatId, '123456');
  assert.deepEqual(events[1][1], { attemptId: 'attempt_1', outcome: 'completed' });
  assert.equal(calls, 2);

  calls = 0;
  const auditDown = createHhResponseConversationRead({ ...ports,
    conversationAudit: { start: async () => { throw new Error('private'); }, finish: async () => {} },
    fetchImpl: async url => { calls++; return result(detail()); } });
  assert.equal((await auditDown({ profileId }, { vacancyId, negotiationId })).status, 503);
  assert.equal(calls, 1, 'audit outage must prevent the chat history GET');
});
