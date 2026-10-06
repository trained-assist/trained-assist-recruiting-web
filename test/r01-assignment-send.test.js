import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAssignmentMessageOutbox, createAssignmentMaterialSender,
  createHhChatMessageSend } from '../src/r01-assignment-send.js';

const operation = Object.freeze({ profileId: 'profile_A', vacancyId: 'vacancy_A',
  negotiationId: 'negotiation_A', chatId: 'chat_A', agreementMessageId: 'agreement_A',
  sourceSha256: 'a'.repeat(64), savedPlanRevisionSha256: 'b'.repeat(64),
  materialSha256: createHash('sha256').update('Exact saved assignment').digest('hex'), message: 'Exact saved assignment' });
const cpOperation = { vacancyId: operation.vacancyId, negotiationId: operation.negotiationId,
  chatId: operation.chatId, sourceSha256: operation.sourceSha256,
  savedPlanRevisionSha256: operation.savedPlanRevisionSha256, materialSha256: operation.materialSha256,
  agreementMessageId: operation.agreementMessageId, message: operation.message };
const operationCanonical = Object.fromEntries(Object.entries(cpOperation).sort(([a], [b]) => a.localeCompare(b)));
const operationHash = createHash('sha256').update(JSON.stringify({ audience: 'recruiting-web', clientId: 'recruiting-web',
  commandId: 'recruiting.assignment.material.send', operation: operationCanonical,
  sourceRevision: operation.savedPlanRevisionSha256 })).digest('hex');
const receipt = Object.freeze({ receiptId: 'receipt_A', audience: 'recruiting-web', clientId: 'recruiting-web',
  command: 'recruiting.assignment.material.send', requestHash: operationHash,
  sourceRevision: operation.savedPlanRevisionSha256, profileId: operation.profileId, operation: cpOperation });
const agreed = () => ({ profileId: 'profile_A', vacancyId: 'vacancy_A', negotiationId: 'negotiation_A', chatId: 'chat_A',
  messages: [{ id: 'agreement_A', role: 'APPLICANT', text: 'Yes, I agree', createdAt: '2026-10-06T07:59:00Z' }] });
const binding = { status: 200, body: { profileId: operation.profileId, vacancyId: operation.vacancyId,
  sourceSha256: operation.sourceSha256, savedPlanRevisionSha256: operation.savedPlanRevisionSha256,
  materialSha256: operation.materialSha256, message: operation.message } };
const goodId = '123e4567-e89b-42d3-a456-426614174000';

function privateOutbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'assignment-send-')));
  chmodSync(dir, 0o700);
  const outbox = new SqliteAssignmentMessageOutbox({ filename: join(dir, 'state.sqlite'),
    clock: () => new Date('2026-10-06T08:00:00.000Z') });
  t.after(() => { outbox.close(); rmSync(dir, { recursive: true, force: true }); });
  return outbox;
}

test('one CP-receipted exact send persists first, posts once, refreshes, and replays as verified', async t => {
  const outbox = privateOutbox(t), calls = [];
  let history = agreed();
  const send = createAssignmentMaterialSender({ outbox,
    loadSavedMaterialBinding: async () => binding,
    readFreshConversation: async () => structuredClone(history),
    sendHhMessage: async request => {
      calls.push(request);
      const record = outbox.find(operation.profileId, operation.negotiationId, operation.agreementMessageId);
      assert.equal(record.state, 'dispatching', 'durable dispatch fence precedes provider call');
      assert.equal(record.idempotencyKey, request.idempotencyKey);
      assert.deepEqual(record.receipt, receipt, 'exact CP receipt is durable before provider dispatch');
      history.messages.push({ id: 'outbound_A', role: 'EMPLOYER', text: request.text,
        createdAt: '2026-10-06T08:00:01Z' });
      return { kind: 'accepted', messageId: 'outbound_A' };
    }, clock: () => new Date('2026-10-06T08:00:00Z'), createId: (() => { let n = 0; return () =>
      `123e4567-e89b-42d3-a456-42661417400${n++}`; })() });
  const request = { context: { profileId: operation.profileId }, operation, receipt,
    agreementConfirmed: true };
  const first = await send(request);
  assert.deepEqual(first, { status: 200, body: { state: 'verified', providerMessageId: 'outbound_A' } });
  assert.equal(calls.length, 1);
  assert.equal(outbox.find(operation.profileId, operation.negotiationId, operation.agreementMessageId).state, 'verified');
  assert.deepEqual(await send(request), first);
  assert.equal(calls.length, 1, 'verified replay never posts again');
});

test('timeout stays unknown, and later fresh history reconciles without another POST', async t => {
  const outbox = privateOutbox(t), calls = [];
  let history = agreed();
  const send = createAssignmentMaterialSender({ outbox, loadSavedMaterialBinding: async () => binding,
    readFreshConversation: async () => structuredClone(history),
    sendHhMessage: async () => { calls.push(1); throw new Error('network timeout'); },
    createId: () => goodId });
  const request = { context: { profileId: operation.profileId }, operation, receipt, agreementConfirmed: true };
  const uncertain = await send(request);
  assert.equal(uncertain.status, 202);
  assert.equal(outbox.find(operation.profileId, operation.negotiationId, operation.agreementMessageId).state, 'unknown');
  history.messages.push({ id: 'outbound_A', role: 'EMPLOYER', text: operation.message,
    createdAt: '2026-10-06T08:00:01Z' });
  const reconciled = await send(request);
  assert.deepEqual(reconciled, { status: 200, body: { state: 'verified', providerMessageId: 'outbound_A' } });
  assert.equal(calls.length, 1);
});

test('restart with a claimed dispatch performs read-only reconciliation and never posts again', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'assignment-send-crash-')));
  chmodSync(dir, 0o700);
  const filename = join(dir, 'state.sqlite');
  const first = new SqliteAssignmentMessageOutbox({ filename });
  const prepared = first.prepare({ operation, receipt, operationId: goodId,
    idempotencyKey: '223e4567-e89b-42d3-a456-426614174000' });
  assert.equal(prepared.kind, 'created');
  assert.ok(first.beginDispatch(goodId));
  first.close();
  const restarted = new SqliteAssignmentMessageOutbox({ filename });
  t.after(() => { restarted.close(); rmSync(dir, { recursive: true, force: true }); });
  let posts = 0;
  const send = createAssignmentMaterialSender({ outbox: restarted,
    loadSavedMaterialBinding: async () => binding, readFreshConversation: async () => agreed(),
    sendHhMessage: async () => { posts++; throw new Error('must not dispatch after restart'); } });
  const result = await send({ context: { profileId: operation.profileId }, operation, receipt, agreementConfirmed: true });
  assert.equal(result.status, 202);
  assert.equal(result.body.state, 'outcome_unknown');
  assert.equal(posts, 0);
  assert.equal(restarted.find(operation.profileId, operation.negotiationId, operation.agreementMessageId).state, 'unknown');
});

test('stale agreement, duplicate outbound, changed saved source and unconfirmed agreement all block send', async t => {
  for (const scenario of [
    { history: { ...agreed(), messages: [...agreed().messages, { id: 'outbound_old', role: 'EMPLOYER',
      text: 'Already replied', createdAt: '2026-10-06T08:00:01Z' }] }, confirm: true, binding, expected: 'fresh_candidate_agreement_required' },
    { history: { ...agreed(), messages: [...agreed().messages, { id: 'same_text', role: 'EMPLOYER',
      text: operation.message, createdAt: '2026-10-06T07:59:30Z' }] }, confirm: true, binding, expected: 'fresh_candidate_agreement_required' },
    { history: agreed(), confirm: false, binding, expected: 'fresh_candidate_agreement_required' },
    { history: agreed(), confirm: true, binding: { ...binding, body: { ...binding.body, sourceSha256: 'e'.repeat(64) } }, expected: 'saved_assignment_changed' }
  ]) {
    const outbox = privateOutbox(t); let posts = 0;
    const send = createAssignmentMaterialSender({ outbox, loadSavedMaterialBinding: async () => scenario.binding,
      readFreshConversation: async () => structuredClone(scenario.history),
      sendHhMessage: async () => { posts++; return { kind: 'accepted' }; }, createId: () => goodId });
    const result = await send({ context: { profileId: operation.profileId }, operation, receipt,
      agreementConfirmed: scenario.confirm });
    assert.equal(result.body.error, scenario.expected);
    assert.equal(posts, 0);
  }
});

test('HH adapter sends one UUID-keyed POST and treats empty 201 body as accepted', async () => {
  const calls = [];
  const send = createHhChatMessageSend({ loadCredential: async profileId => ({ profileId, accessToken: 'token_A' }),
    userAgent: 'Recruiting Test test@example.invalid', fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options }); return { status: 201, json: async () => { throw new Error('empty'); } };
    } });
  assert.deepEqual(await send({ profileId: 'profile_A', chatId: 'chat_A', idempotencyKey: goodId,
    text: operation.message }), { kind: 'accepted', messageId: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, 'https://api.hh.ru/common/chats/chat_A/messages');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer token_A');
  assert.deepEqual(JSON.parse(calls[0].options.body), { idempotency_key: goodId, text: operation.message });
});

test('HH UUID collision or network error is ambiguous and is never automatically retried', async () => {
  for (const result of [ { status: 409 }, new Error('timeout') ]) {
    let calls = 0;
    const send = createHhChatMessageSend({ loadCredential: async profileId => ({ profileId, accessToken: 'token_A' }),
      userAgent: 'Recruiting Test test@example.invalid', fetchImpl: async () => {
        calls++; if (result instanceof Error) throw result; return result;
      } });
    const response = await send({ profileId: 'profile_A', chatId: 'chat_A', idempotencyKey: goodId, text: operation.message });
    assert.equal(response.kind, 'unknown');
    assert.equal(calls, 1);
  }
});
