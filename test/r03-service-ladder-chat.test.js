import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceLadderChat } from '../src/r03-service-ladder-chat.js';
import { createHhQueryGenerator } from '../src/r03-hh-query-generator.js';

const args = { messages: [{ role: 'user', content: 'Вымышленный инженер' }],
  ladder: 'service', temperature: 0.3, maxTokens: 300, timeoutMs: 20_000,
  source: 'hh-proactive' };

test('service-ladder HTTP contract yields vacancy-bound HH queries', async () => {
  let requests = 0, loads = 0;
  const chat = createServiceLadderChat({ loadToken: async () => { loads++; return 'invented_service_token'; },
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url, 'https://llm-ladder.trainedassist.store/v1/chat/completions');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer invented_service_token');
      assert.equal(options.headers['x-ladder-app'], 'hh-proactive');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'service');
      assert.equal(body.messages[0].role, 'user');
      assert.match(body.messages[0].content, /Вымышленный инженер/);
      assert.equal(body.temperature, 0.3);
      assert.equal(body.max_tokens, 300);
      assert.equal(body.ladder_timeout_ms, 20_000);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '["Вымышленный инженер"]' } }] }) };
    } });
  const generate = createHhQueryGenerator({ chat });
  assert.deepEqual(await generate({ profileId: 'profile_invented_001', vacancyId: 'vacancy_invented_001',
    atsConfig: { vacancy_title: 'Вымышленный инженер', required: [{ name: 'инженер', weight: 2 }] } }),
  ['Вымышленный инженер']);
  assert.equal(requests, 1);
  assert.equal(loads, 1);
});

test('bad token, invalid request, HTTP failure and malformed response fail without provider text', async () => {
  const sourceSecret = 'PRIVATE_CANDIDATE_NAME';
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 500,
    json: async () => ({ error: { message: sourceSecret } }) }; };
  const missing = createServiceLadderChat({ loadToken: async () => sourceSecret + ' with spaces', fetchImpl });
  await assert.rejects(missing(args), error => error.message === 'service_ladder_unavailable');
  assert.equal(calls, 0);
  const invalid = createServiceLadderChat({ loadToken: async () => 'invented_token', fetchImpl });
  await assert.rejects(invalid({ ...args, ladder: 'conversation' }), /service_ladder_unavailable/);
  assert.equal(calls, 0);
  await assert.rejects(invalid(args), error => error.message === 'service_ladder_unavailable');
  const malformed = createServiceLadderChat({ loadToken: async () => 'invented_token',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }) });
  await assert.rejects(malformed(args), /service_ladder_unavailable/);
  assert.throws(() => createServiceLadderChat({}), /credential and HTTP ports required/);
});
