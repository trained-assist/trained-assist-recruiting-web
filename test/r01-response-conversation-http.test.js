import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRecruitingServer } from '../src/server.js';

test('only explicit conversation route reads messages and page names the viewed effect', async t => {
  let conversationReads = 0, listReads = 0, detailReads = 0;
  let scopes = ['recruiting.responses.read'];
  const connectedAppBff = { handle: async () => false, resolve: async () => ({ profileId: 'profile_A',
    sub: 'user_A', scopes }) };
  const server = createRecruitingServer({ connectedAppBff, privateProactiveOnly: true,
    liveResponseRead: async () => { listReads++; return { status: 200, body: { domainApiVersion: 'v1',
      profileId: 'profile_A', vacancyId: 'vacancy_A', state: 'response', page: 0, total: 0, pages: 0,
      items: [], sourceRevision: 'a'.repeat(64), fetchedAt: '2026-10-06T08:00:00.000Z',
      freshness: 'live_at_request', paginationConsistency: 'best_effort' } }; },
    liveResponseDetailRead: async () => { detailReads++; return { status: 200, body: { domainApiVersion: 'v1',
      profileId: 'profile_A', vacancyId: 'vacancy_A', negotiationId: 'negotiation_A', resumeId: 'resume_A',
      state: 'response', updatedAt: null, fetchedAt: '2026-10-06T08:00:00.000Z', freshness: 'live_at_request' } }; },
    liveResponseConversationRead: async (_context, input) => { conversationReads++;
      if (input.vacancyId !== 'vacancy_A') return { status: 404, body: { error: 'conversation_not_found' } };
      assert.deepEqual(input, { vacancyId: 'vacancy_A', negotiationId: 'negotiation_A' });
      return { status: 200, body: { profileId: 'profile_A', vacancyId: 'vacancy_A',
        negotiationId: 'negotiation_A', chatId: 'chat_A', messages: [{ id: 'message_A',
          createdAt: '2026-10-06T07:00:00.000Z', type: 'SIMPLE', text: '<hello>', viewedByOpponent: false }],
        hasMore: true, fetchedAt: '2026-10-06T08:00:00.000Z' } };
    } });
  server.listen(0, '127.0.0.1');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = await fetch(`${base}/hh/responses?vacancy_id=vacancy_A`);
  assert.equal(list.status, 200);
  assert.equal(conversationReads, 0);
  const detail = await fetch(`${base}/hh/response-detail?vacancy_id=vacancy_A&negotiation_id=negotiation_A`);
  assert.equal(detail.status, 200);
  assert.equal(conversationReads, 0);
  const page = await fetch(`${base}/hh/response-conversation?vacancy_id=vacancy_A&negotiation_id=negotiation_A`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal(conversationReads, 0, 'GET renders confirmation and never requests HH messages');
  assert.equal(listReads, 1);
  assert.equal(detailReads, 1);
  assert.match(html, /может отметить отклик просмотренным в HH/);
  assert.match(html, /Загрузить историю переписки/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const script = await fetch(`${base}/hh/response-conversation/app.js`);
  const scriptBody = await script.text();
  assert.match(scriptBody, /method:'POST'/);
  assert.match(scriptBody, /x-csrf-token/);
  assert.match(scriptBody, /textContent=text/);
  assert.doesNotMatch(scriptBody, /innerHTML|document\.write/);
  const conversationUrl = `${base}/hh/response-conversation?vacancy_id=vacancy_A&negotiation_id=negotiation_A`;
  const denied = await fetch(conversationUrl, { method: 'POST' });
  assert.equal(denied.status, 403, 'read scope alone cannot open history');
  assert.equal(conversationReads, 0);
  scopes = ['recruiting.responses.read', 'recruiting.responses.conversation.open'];
  const opened = await fetch(conversationUrl, { method: 'POST', headers: { origin: base, 'x-csrf-token': 'fixture' } });
  assert.equal(opened.status, 200);
  const payload = await opened.json();
  assert.equal(payload.messages[0].text, '<hello>');
  assert.equal(conversationReads, 1);
  const foreign = await fetch(`${base}/hh/response-conversation?vacancy_id=vacancy_B&negotiation_id=negotiation_A`,
    { method: 'POST', headers: { origin: base, 'x-csrf-token': 'fixture' } });
  assert.equal(foreign.status, 404);
  assert.equal(conversationReads, 2);
  assert.equal((await fetch(conversationUrl, { method: 'DELETE' })).status, 405);
  assert.equal(conversationReads, 2);
});
