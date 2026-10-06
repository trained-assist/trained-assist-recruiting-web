import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRecruitingServer } from '../src/server.js';

test('only explicit conversation route reads messages and page names the viewed effect', async t => {
  let conversationReads = 0, listReads = 0, detailReads = 0;
  const connectedAppBff = { handle: async () => false, resolve: async () => ({ profileId: 'profile_A',
    sub: 'user_A', scopes: ['recruiting.responses.read'] }) };
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
  assert.equal(conversationReads, 1);
  assert.equal(listReads, 1);
  assert.equal(detailReads, 1);
  assert.match(html, /HH может отметить отклик просмотренным/);
  assert.match(html, /последние 50 сообщений/);
  assert.match(html, /&lt;hello&gt;/);
  assert.doesNotMatch(html, /<hello>/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/hh/response-conversation?vacancy_id=vacancy_B&negotiation_id=negotiation_A`)).status, 404);
  assert.equal(conversationReads, 2);
  assert.equal((await fetch(`${base}/hh/response-conversation?vacancy_id=vacancy_A&negotiation_id=negotiation_A`,
    { method: 'POST' })).status, 405);
  assert.equal(conversationReads, 2);
});
