import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const norm = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : plain(value)
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  : JSON.stringify(value);
function cpOperation(operation) {
  return { vacancyId: operation.vacancyId, negotiationId: operation.negotiationId, chatId: operation.chatId,
    sourceSha256: operation.sourceSha256, savedPlanRevisionSha256: operation.savedPlanRevisionSha256,
    materialSha256: operation.materialSha256, agreementMessageId: operation.agreementMessageId,
    message: operation.message };
}

function validReceipt(receipt, operation) {
  const exactOperation = cpOperation(operation);
  if (!plain(receipt) || receipt.audience !== 'recruiting-web' ||
      receipt.clientId !== 'recruiting-web' || receipt.command !== 'recruiting.assignment.material.send' ||
      !safeId(receipt.profileId) || receipt.profileId !== operation.profileId ||
      !safeId(receipt.receiptId) || !hex(receipt.requestHash) ||
      receipt.sourceRevision !== operation.savedPlanRevisionSha256 || !plain(receipt.operation) ||
      stable(receipt.operation) !== stable(exactOperation)) return false;
  const expectedRequestHash = digest(JSON.stringify({ audience: 'recruiting-web', clientId: 'recruiting-web',
    commandId: 'recruiting.assignment.material.send', operation: JSON.parse(stable(exactOperation)),
    sourceRevision: operation.savedPlanRevisionSha256 }));
  return receipt.requestHash === expectedRequestHash;
}

function validOperation(operation) {
  return plain(operation) && Object.keys(operation).sort().join(',') ===
    'agreementMessageId,chatId,materialSha256,message,negotiationId,profileId,savedPlanRevisionSha256,sourceSha256,vacancyId' &&
    ['profileId', 'vacancyId', 'negotiationId', 'chatId', 'agreementMessageId']
    .every(key => safeId(operation[key])) &&
    ['sourceSha256', 'savedPlanRevisionSha256', 'materialSha256'].every(key => hex(operation[key])) &&
    typeof operation.message === 'string' && operation.message.trim().length > 0 &&
    operation.message.length <= 12_000 && digest(operation.message) === operation.materialSha256;
}

// Private durable ledger. A dispatching row is never dispatched again after
// restart; it can only be reconciled from fresh HH history.
export class SqliteAssignmentMessageOutbox {
  constructor({ filename, clock = () => new Date() } = {}) {
    if (typeof filename !== 'string' || !isAbsolute(filename) || resolve(filename) !== filename ||
        realpathSync(dirname(filename)) !== dirname(filename) || (statSync(dirname(filename)).mode & 0o077) !== 0 ||
        typeof clock !== 'function') throw new TypeError('private_assignment_outbox_configuration_required');
    try { const info = lstatSync(filename); if (!info.isFile() || info.mode & 0o077) throw new TypeError('private_assignment_outbox_configuration_required'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    this.db = new Database(filename, { timeout: 5000 });
    this.clock = clock;
    chmodSync(filename, 0o600);
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS assignment_message_outbox (
      operation_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      vacancy_id TEXT NOT NULL,
      negotiation_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      agreement_message_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','dispatching','accepted','unknown','verified','blocked_duplicate')),
      provider_message_id TEXT,
      created_at TEXT NOT NULL,
      dispatch_started_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(profile_id, negotiation_id, agreement_message_id)
    )`);
    this.getById = this.db.prepare('SELECT * FROM assignment_message_outbox WHERE operation_id=?');
    this.getByAgreement = this.db.prepare(`SELECT * FROM assignment_message_outbox
      WHERE profile_id=? AND negotiation_id=? AND agreement_message_id=?`);
    this.insert = this.db.prepare(`INSERT INTO assignment_message_outbox
      (operation_id,profile_id,vacancy_id,negotiation_id,chat_id,agreement_message_id,request_hash,receipt_id,
       idempotency_key,payload,state,provider_message_id,created_at,dispatch_started_at,updated_at)
      VALUES (@operationId,@profileId,@vacancyId,@negotiationId,@chatId,@agreementMessageId,@requestHash,@receiptId,
       @idempotencyKey,@payload,'prepared',NULL,@now,NULL,@now)`);
    this.begin = this.db.prepare(`UPDATE assignment_message_outbox SET state='dispatching',dispatch_started_at=?,updated_at=?
      WHERE operation_id=? AND state='prepared'`);
    this.setOutcome = this.db.prepare(`UPDATE assignment_message_outbox SET state=?,provider_message_id=?,updated_at=?
      WHERE operation_id=? AND state IN ('dispatching','accepted','unknown')`);
  }

  close() { this.db.close(); }
  row(raw) {
    if (!raw) return null;
    return { operationId: raw.operation_id, profileId: raw.profile_id, vacancyId: raw.vacancy_id,
      negotiationId: raw.negotiation_id, chatId: raw.chat_id, agreementMessageId: raw.agreement_message_id,
      requestHash: raw.request_hash, receiptId: raw.receipt_id, idempotencyKey: raw.idempotency_key,
      operation: JSON.parse(raw.payload).operation, receipt: JSON.parse(raw.payload).receipt,
      state: raw.state, providerMessageId: raw.provider_message_id,
      createdAt: raw.created_at, dispatchStartedAt: raw.dispatch_started_at, updatedAt: raw.updated_at };
  }
  prepare({ operation, receipt, operationId = randomUUID(), idempotencyKey = randomUUID() } = {}) {
    if (!validOperation(operation) || !validReceipt(receipt, operation) || !uuid(operationId) || !uuid(idempotencyKey))
      return { kind: 'invalid' };
    const now = this.clock().toISOString();
    const hash = digest(JSON.stringify({ operation, receiptId: receipt.receiptId, requestHash: receipt.requestHash }));
    const prior = this.row(this.getByAgreement.get(operation.profileId, operation.negotiationId, operation.agreementMessageId));
    if (prior) return prior.requestHash === hash
      ? { kind: 'replay', record: prior } : { kind: 'conflict' };
    try {
      this.insert.run({ operationId, profileId: operation.profileId, vacancyId: operation.vacancyId,
        negotiationId: operation.negotiationId, chatId: operation.chatId,
        agreementMessageId: operation.agreementMessageId, requestHash: hash,
        receiptId: receipt.receiptId, idempotencyKey, payload: JSON.stringify({ operation, receipt }), now });
      return { kind: 'created', record: this.row(this.getById.get(operationId)) };
    } catch (error) {
      if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        const raced = this.row(this.getByAgreement.get(operation.profileId, operation.negotiationId, operation.agreementMessageId));
        return raced?.requestHash === hash ? { kind: 'replay', record: raced } : { kind: 'conflict' };
      }
      throw error;
    }
  }
  beginDispatch(operationId) {
    const now = this.clock().toISOString();
    return this.begin.run(now, now, operationId).changes === 1
      ? this.row(this.getById.get(operationId)) : null;
  }
  finish(operationId, { state, providerMessageId = null } = {}) {
    if (!['accepted', 'unknown', 'verified', 'blocked_duplicate'].includes(state) ||
        providerMessageId !== null && !safeId(String(providerMessageId))) throw new TypeError('invalid_assignment_outcome');
    const now = this.clock().toISOString();
    const changed = this.setOutcome.run(state, providerMessageId === null ? null : String(providerMessageId), now, operationId);
    return changed.changes === 1 ? this.row(this.getById.get(operationId)) : null;
  }
  get(operationId) { return this.row(this.getById.get(operationId)); }
  find(profileId, negotiationId, agreementMessageId) {
    return this.row(this.getByAgreement.get(profileId, negotiationId, agreementMessageId));
  }
}

function freshAgreement(history, operation, agreementConfirmed) {
  if (agreementConfirmed !== true || !plain(history) || history.profileId !== operation.profileId ||
      history.vacancyId !== operation.vacancyId || history.negotiationId !== operation.negotiationId ||
      history.chatId !== operation.chatId || !Array.isArray(history.messages)) return false;
  const ordered = [...history.messages].filter(message => plain(message) &&
    ['EMPLOYER', 'APPLICANT'].includes(message.role) && typeof message.text === 'string' &&
    Number.isFinite(Date.parse(message.createdAt))).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const agreement = ordered.find(message => message.id === operation.agreementMessageId);
  const latest = ordered.at(-1);
  if (!agreement || agreement.role !== 'APPLICANT' || latest?.id !== agreement.id) return false;
  return !ordered.some(message => message.role === 'EMPLOYER' && Date.parse(message.createdAt) >= Date.parse(agreement.createdAt));
}

function hasDuplicateOutbound(history, text) {
  return history.messages.some(message => message?.role === 'EMPLOYER' && typeof message.text === 'string' && norm(message.text) === norm(text));
}

function verifyFreshOutbound(history, record) {
  if (!plain(history) || history.profileId !== record.profileId || history.vacancyId !== record.vacancyId ||
      history.negotiationId !== record.negotiationId || history.chatId !== record.chatId || !Array.isArray(history.messages)) return null;
  const found = history.messages.find(message => message?.role === 'EMPLOYER' && typeof message.text === 'string' &&
    message.text === record.operation.message && Date.parse(message.createdAt) >= Date.parse(record.dispatchStartedAt));
  return found && safeId(String(found.id ?? '')) ? String(found.id) : null;
}

export function createAssignmentMaterialSender({ outbox, readFreshConversation, sendHhMessage,
  loadSavedMaterialBinding, clock = () => new Date(), createId = randomUUID } = {}) {
  if (!outbox || !['prepare', 'beginDispatch', 'finish', 'get', 'find'].every(key => typeof outbox[key] === 'function') ||
      typeof readFreshConversation !== 'function' || typeof sendHhMessage !== 'function' ||
      typeof loadSavedMaterialBinding !== 'function' || typeof clock !== 'function' || typeof createId !== 'function')
    throw new TypeError('assignment_sender_ports_required');

  return async ({ context, operation, receipt, agreementConfirmed, idempotencyKey } = {}) => {
    if (!validOperation(operation) || context?.profileId !== operation.profileId || !validReceipt(receipt, operation))
      return { status: 400, body: { error: 'invalid_assignment_send' } };
    const receiptHash = digest(JSON.stringify({ operation, receiptId: receipt.receiptId, requestHash: receipt.requestHash }));
    const prior = outbox.find(operation.profileId, operation.negotiationId, operation.agreementMessageId);
    let existingPrepared = null;
    if (prior) {
      if (prior.requestHash !== receiptHash) return { status: 409, body: { error: 'assignment_send_conflict' } };
      if (prior.state === 'verified') return { status: 200, body: { state: 'verified', providerMessageId: prior.providerMessageId } };
      if (prior.state === 'prepared') existingPrepared = prior;
      else {
      try {
        const history = await readFreshConversation({ profileId: prior.profileId, vacancyId: prior.vacancyId,
          negotiationId: prior.negotiationId, chatId: prior.chatId });
        const found = verifyFreshOutbound(history, prior);
        if (found) {
          const updated = outbox.finish(prior.operationId, { state: 'verified', providerMessageId: found });
          return { status: 200, body: { state: 'verified', providerMessageId: updated?.providerMessageId ?? found } };
        }
      } catch { /* Keep unknown; never repeat the provider write. */ }
      if (prior.state === 'dispatching') outbox.finish(prior.operationId, { state: 'unknown' });
      return { status: 202, body: { state: 'outcome_unknown', operationId: prior.operationId } };
      }
    }
    let saved;
    try { saved = await loadSavedMaterialBinding(context, operation.vacancyId); }
    catch { return { status: 503, body: { error: 'assignment_unavailable' } }; }
    if (saved?.status !== 200 || saved.body?.profileId !== operation.profileId ||
        saved.body?.vacancyId !== operation.vacancyId || saved.body?.sourceSha256 !== operation.sourceSha256 ||
        saved.body?.savedPlanRevisionSha256 !== operation.savedPlanRevisionSha256 ||
        saved.body?.materialSha256 !== operation.materialSha256 || saved.body?.message !== operation.message)
      return { status: 409, body: { error: 'saved_assignment_changed' } };

    let before;
    try { before = await readFreshConversation({ profileId: operation.profileId, vacancyId: operation.vacancyId,
      negotiationId: operation.negotiationId, chatId: operation.chatId }); }
    catch { return { status: 503, body: { error: 'conversation_unavailable' } }; }
    if (!freshAgreement(before, operation, agreementConfirmed))
      return { status: 409, body: { error: 'fresh_candidate_agreement_required' } };
    if (hasDuplicateOutbound(before, operation.message))
      return { status: 409, body: { error: 'duplicate_outbound_material' } };

    const prepared = existingPrepared ? { kind: 'replay', record: existingPrepared } : outbox.prepare({ operation, receipt,
      operationId: createId(), idempotencyKey: idempotencyKey ?? createId() });
    if (prepared.kind === 'invalid') return { status: 400, body: { error: 'invalid_assignment_send' } };
    if (prepared.kind === 'conflict') return { status: 409, body: { error: 'assignment_send_conflict' } };
    let record = prepared.record;
    if (prepared.kind === 'replay' && record.state !== 'prepared')
      return { status: 202, body: { state: 'outcome_unknown', operationId: record.operationId } };

    record = outbox.beginDispatch(record.operationId);
    if (!record) return { status: 202, body: { state: 'outcome_unknown' } };
    let providerResult;
    try { providerResult = await sendHhMessage({ profileId: record.profileId, chatId: record.chatId,
      idempotencyKey: record.idempotencyKey, text: record.operation.message }); }
    catch { outbox.finish(record.operationId, { state: 'unknown' }); providerResult = { kind: 'unknown' }; }
    if (providerResult?.kind === 'accepted') outbox.finish(record.operationId, {
      state: 'accepted', providerMessageId: providerResult.messageId ?? null });
    else if (providerResult?.kind !== 'unknown') outbox.finish(record.operationId, { state: 'unknown' });

    try {
      const after = await readFreshConversation({ profileId: record.profileId, vacancyId: record.vacancyId,
        negotiationId: record.negotiationId, chatId: record.chatId });
      const found = verifyFreshOutbound(after, record);
      if (found) {
        const verified = outbox.finish(record.operationId, { state: 'verified', providerMessageId: found });
        return { status: 200, body: { state: 'verified', providerMessageId: verified?.providerMessageId ?? found } };
      }
    } catch { /* Keep accepted/unknown for later read-only reconciliation. */ }
    return { status: 202, body: { state: 'outcome_unknown', operationId: record.operationId } };
  };
}

// Single-attempt HH transport. The durable UUID must be created and persisted
// before this function is called. This adapter never retries a POST.
export function createHhChatMessageSend({ loadCredential, fetchImpl = globalThis.fetch,
  userAgent, timeoutMs = 8_000 } = {}) {
  if (typeof loadCredential !== 'function' || typeof fetchImpl !== 'function' ||
      typeof userAgent !== 'string' || userAgent.length < 3 || userAgent.length > 200 ||
      !/^[\x20-\x7e]+$/.test(userAgent) || !userAgent.includes('@') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
    throw new TypeError('HH assignment send ports required');
  return async ({ profileId, chatId, idempotencyKey, text } = {}) => {
    if (!safeId(profileId) || !safeId(chatId) || !uuid(idempotencyKey) ||
        typeof text !== 'string' || !text.trim() || text.length > 12_000) return { kind: 'rejected' };
    let credential;
    try { credential = await loadCredential(profileId); } catch { return { kind: 'unavailable' }; }
    if (credential?.profileId !== profileId || typeof credential.accessToken !== 'string' || !credential.accessToken)
      return { kind: 'unavailable' };
    let response;
    try {
      response = await fetchImpl(`https://api.hh.ru/common/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${credential.accessToken}`,
          accept: 'application/json', 'content-type': 'application/json', 'HH-User-Agent': userAgent },
        body: JSON.stringify({ idempotency_key: idempotencyKey, text }),
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)
      });
    } catch { return { kind: 'unknown' }; }
    if (response.status === 201) {
      let body = null;
      try { body = await response.json(); } catch { /* HH may return an empty success body. */ }
      return { kind: 'accepted', messageId: safeId(String(body?.id ?? '')) ? String(body.id) : null };
    }
    if ([400, 401, 403, 404].includes(response.status)) return { kind: 'rejected' };
    // 409 means a UUID conflict and 5xx/network failures are ambiguous.
    return { kind: 'unknown' };
  };
}
