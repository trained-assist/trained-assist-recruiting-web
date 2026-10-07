import test from 'node:test';
import assert from 'node:assert/strict';
import { createHhQueryGenerator } from '../src/r03-hh-query-generator.js';

const input = { profileId: 'profile_invented_001', vacancyId: 'vacancy_invented_001',
  atsConfig: { vacancy_title: 'Инженер конструктор', vacancy_context: 'Проектирование станков',
    required: [{ name: 'проектирование станков', weight: 5 },
      { name: 'технические чертежи', weight: 3 }] },
  comments: ['Не подходит только административный опыт'] };

test('specialized LLM queries reach the cache with scoped prompt and service ladder', async () => {
  let request;
  const generate = createHhQueryGenerator({ chat: async value => {
    request = value;
    return '["Инженер конструктор станков","Проектирование станков"]';
  } });
  assert.deepEqual(await generate(input), ['Инженер конструктор станков', 'Проектирование станков']);
  assert.equal(request.ladder, 'service');
  assert.equal(request.timeoutMs, 20_000);
  assert.match(request.messages[0].content, /административный опыт/);
});

test('off-topic, malformed and duplicate LLM responses use only vacancy-derived fallback', async () => {
  const expected = ['Инженер конструктор', 'проектирование станков', 'технические чертежи'];
  for (const answer of ['["Data Scientist","ML Engineer"]', 'not JSON',
    '["Инженер конструктор","Инженер конструктор"]']) {
    const generate = createHhQueryGenerator({ chat: async () => answer });
    assert.deepEqual(await generate(input), expected);
  }
});

test('provider failure and unanchored vacancy fail without returning candidate or comment text', async () => {
  const generate = createHhQueryGenerator({ chat: async () => { throw new Error('PRIVATE_CANDIDATE_NAME'); } });
  await assert.rejects(generate(input), error => error.message === 'hh_query_generation_unavailable');
  await assert.rejects(generate({ ...input, atsConfig: {} }), /hh_query_generation_unavailable/);
  await assert.rejects(generate({ ...input, comments: [42] }), /hh_query_generation_unavailable/);
  assert.throws(() => createHhQueryGenerator({}), /HH query chat port required/);
});
