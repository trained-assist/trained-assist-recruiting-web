import test from 'node:test';
import assert from 'node:assert/strict';
import { createHhAssessmentEvaluator } from '../src/r03-hh-assessment-evaluator.js';
import { createFreeLadderChat } from '../src/r03-free-ladder-chat.js';

const profileId = 'profile_invented_001';
const vacancyId = 'vacancy_invented_001';
const criteriaRevision = 'criteria_invented_001';
const candidate = { id: 'inventedresume001', vacancyId, title: 'Инженер конструктор',
  firstName: 'PRIVATE_CANDIDATE_NAME', lastName: 'PRIVATE_LAST_NAME',
  hhUrl: 'https://hh.ru/resume/inventedresume001', totalExperienceYears: 4,
  recentCompanies: ['Вымышленное бюро'], experience: [{ position: 'Конструктор', company: 'Вымышленное бюро' }] };
const plan = { profileId, vacancyId, criteriaRevision,
  atsConfig: { vacancy_title: 'Инженер конструктор', vacancy_context: 'Проектирование станков',
    required: [{ name: 'чертежи', weight: 3 }], knockout: ['Нет опыта проектирования'],
    pass_threshold: 7, review_threshold: 5 } };
const request = { profileId, vacancyId, candidate, criteriaRevision, inputRevision: 'a'.repeat(32) };

test('free-ladder ATS result becomes a bounded assessment without candidate identity in prompt', async () => {
  let called = 0;
  const chat = createFreeLadderChat({ loadToken: async () => 'invented_free_token',
    fetchImpl: async (url, options) => {
      called++;
      assert.equal(url, 'https://llm-ladder.trainedassist.store/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer invented_free_token');
      assert.equal(options.headers['x-ladder-app'], 'hh-enrich');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'free');
      assert.equal(body.temperature, 0.1);
      assert.equal(body.max_tokens, 600);
      assert.equal(body.ladder_timeout_ms, 25_000);
      assert.doesNotMatch(body.messages[0].content, /PRIVATE_CANDIDATE_NAME|PRIVATE_LAST_NAME|hh\.ru\/resume/);
      return { ok: true, json: async () => ({ choices: [{ message: {
        content: '```json\n{"score":8.2,"knockout_failed":[]}\n```' } }] }) };
    } });
  const evaluate = createHhAssessmentEvaluator({ loadSearchPlan: async () => plan, chat });
  assert.deepEqual(await evaluate(request), { atsScore: 8, atsTag: 'PASS',
    knockout: { status: 'passed', criteria: [] } });
  assert.equal(called, 1);
});

test('confirmed knockout caps score at two; hallucinated knockout and stale criteria fail closed', async () => {
  let answer = '{"score":9,"knockout_failed":["Нет опыта проектирования"]}';
  let calls = 0;
  const evaluate = createHhAssessmentEvaluator({ loadSearchPlan: async () => plan,
    chat: async () => { calls++; return answer; } });
  assert.deepEqual(await evaluate(request), { atsScore: 2, atsTag: 'WEAK',
    knockout: { status: 'failed', criteria: ['Нет опыта проектирования'] } });
  answer = '{"score":9,"knockout_failed":["Выдуманный стоп-фактор"]}';
  await assert.rejects(evaluate(request), /hh_assessment_unavailable/);
  await assert.rejects(evaluate({ ...request, criteriaRevision: 'stale' }), /hh_assessment_unavailable/);
  assert.equal(calls, 2, 'stale criteria are rejected before the LLM call');
  await assert.rejects(evaluate({ ...request, profileId: 'other_profile' }), /hh_assessment_unavailable/);
});

test('malformed or failed model response does not expose provider text', async () => {
  const evaluator = response => createHhAssessmentEvaluator({ loadSearchPlan: async () => plan,
    chat: async () => response });
  for (const response of ['', 'PRIVATE_CANDIDATE_NAME', '{"score":"high","knockout_failed":[]}'])
    await assert.rejects(evaluator(response)(request), error => error.message === 'hh_assessment_unavailable');
  await assert.rejects(createHhAssessmentEvaluator({ loadSearchPlan: async () => plan,
    chat: async () => { throw new Error('PRIVATE_CANDIDATE_NAME'); } })(request),
  error => error.message === 'hh_assessment_unavailable');
});
