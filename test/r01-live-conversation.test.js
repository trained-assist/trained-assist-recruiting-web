import test from 'node:test';
import assert from 'node:assert/strict';
import { createHhConversationRead } from '../src/r01-live-conversation.js';

const userAgent = 'Recruiting Web/1.0 (ops@example.com)';
const response = (status, value) => ({ status, ok: status >= 200 && status < 300,
  json: async () => value });
const negotiation = { id: 'neg_A', vacancy: { id: 'vac_A' }, chat_id: 'chat_A' };
const messages = [{ id: 'msg_2', creation_time: '2026-01-02T00:00:00Z',
  sender_display_info: { role: 'APPLICANT' }, payload: { text: 'Согласен' } },
{ id: 'msg_1', creation_time: '2026-01-01T00:00:00Z',
  sender_display_info: { role: 'EMPLOYER' }, payload: { text: 'Пришлите тестовое' } }];
const call = (fn, args = {}) => fn({ profileId: 'profile_A' }, { vacancyId: 'vac_A', negotiationId: 'neg_A', ...args });

test('reads exact owned negotiation and paginates current chat transport shape', async () => {
  const urls = [];
  const read = createHhConversationRead({ loadCredential: async profileId => ({ profileId, accessToken: 'secret' }),
    isVacancyOwned: () => true, userAgent, clock: () => new Date('2026-01-03T00:00:00Z'),
    fetchImpl: async url => {
      urls.push(String(url));
      if (urls.length === 1) return response(200, negotiation);
      const page = new URL(url).searchParams.get('page');
      return response(200, { messages: page === '0' ? [messages[1]] : [messages[0]], has_more: page === '0' });
    } });
  const result = await call(read);
  assert.equal(result.status, 200);
  assert.equal(result.body.chatId, 'chat_A');
  assert.deepEqual(result.body.messages.map(item => item.id), ['msg_1', 'msg_2']);
  assert.match(urls[1], /common\/chats\/chat_A\/messages\?page=0$/);
  assert.match(urls[2], /common\/chats\/chat_A\/messages\?page=1$/);
});

test('fails closed when the negotiation points to a different vacancy or has no chat', async () => {
  for (const data of [{ ...negotiation, vacancy: { id: 'vac_B' } }, { ...negotiation, chat_id: undefined }]) {
    const read = createHhConversationRead({ loadCredential: async profileId => ({ profileId, accessToken: 'secret' }),
      isVacancyOwned: () => true, userAgent, fetchImpl: async () => response(200, data) });
    assert.equal((await call(read)).status, 404);
  }
});

test('rejects malformed HH history and stops when bounded pagination is exhausted', async () => {
  const malformed = createHhConversationRead({ loadCredential: async profileId => ({ profileId, accessToken: 'secret' }),
    isVacancyOwned: () => true, userAgent, fetchImpl: async url => String(url).includes('/negotiations/')
      ? response(200, negotiation) : response(200, { messages: [{ id: 'x', creation_time: 'bad',
        sender_display_info: { role: 'APPLICANT' }, payload: { text: 'ok' } }], has_more: false }) });
  assert.equal((await call(malformed)).status, 502);
  let pageRequests = 0;
  const bounded = createHhConversationRead({ loadCredential: async profileId => ({ profileId, accessToken: 'secret' }),
    isVacancyOwned: () => true, userAgent, maxPages: 1,
    fetchImpl: async url => String(url).includes('/negotiations/') ? response(200, negotiation)
      : (pageRequests++, response(200, { messages: [], has_more: true })) });
  assert.equal((await call(bounded)).body.error, 'conversation_history_too_large');
  assert.equal(pageRequests, 1);
});

test('keeps profile and vacancy isolation and refuses unowned vacancies before HH access', async () => {
  let calls = 0;
  const read = createHhConversationRead({ loadCredential: async profileId => ({ profileId, accessToken: 'secret' }),
    isVacancyOwned: () => false, userAgent, fetchImpl: async () => (calls++, response(200, negotiation)) });
  assert.equal((await call(read)).status, 404);
  assert.equal(calls, 0);
});
