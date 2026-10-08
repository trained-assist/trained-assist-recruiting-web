// Explicit user-triggered HH conversation read. GET /common/chats/{id}/messages
// can mark a response viewed, so this reader is never wired to list/status GETs.
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const iso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
const MAX_MESSAGES = 50;

function projectMessage(value) {
  if (!value || !safeId(String(value.id ?? '')) || !iso(value.creation_time) ||
      !['SIMPLE', 'PARTICIPANT_LEFT', 'PARTICIPANT_JOINED'].includes(value.type) ||
      typeof value.viewed_by_opponent !== 'boolean') return null;
  const payload = value.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const hasText = typeof payload.text === 'string';
  const hasAttachments = Array.isArray(payload.attachments);
  const hasMoved = payload.moved_participant && typeof payload.moved_participant === 'object';
  if (Number(hasText) + Number(hasAttachments) + Number(Boolean(hasMoved)) !== 1) return null;
  const result = { id: String(value.id), createdAt: iso(value.creation_time), type: value.type,
    viewedByOpponent: value.viewed_by_opponent };
  if (hasText) {
    if (payload.text.length > 20_000) return null;
    result.text = payload.text;
  }
  if (hasAttachments) {
    if (payload.attachments.length > 10 || payload.attachments.some(item => !item ||
        typeof item.url !== 'string' || typeof item.title !== 'string' ||
        typeof item.content_type !== 'string' || item.title.length > 300)) return null;
    // Do not project provider URLs: attachment links can be signed/private.
    result.attachments = payload.attachments.map(item => ({ title: item.title, contentType: item.content_type }));
  }
  if (hasMoved) result.movedParticipant = { id: safeId(String(payload.moved_participant.id ?? ''))
    ? String(payload.moved_participant.id) : null };
  return result;
}

export function createHhResponseConversationRead({ loadCredential, refreshCredential, fetchImpl,
  isVacancyOwned, userAgent, clock = () => new Date(), timeoutMs = 8_000,
  conversationAudit = null, createAttemptId = randomUUID } = {}) {
  if (typeof loadCredential !== 'function' || typeof fetchImpl !== 'function' ||
      typeof isVacancyOwned !== 'function' || typeof clock !== 'function' ||
      typeof userAgent !== 'string' || userAgent.length < 3 || userAgent.length > 200 ||
      !/^[\x20-\x7e]+$/.test(userAgent) || !userAgent.includes('@') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
      (conversationAudit !== null && (typeof conversationAudit.start !== 'function' ||
        typeof conversationAudit.finish !== 'function')) || typeof createAttemptId !== 'function')
    throw new TypeError('HH response conversation ports required');

  return async (context, { vacancyId, negotiationId } = {}) => {
    const profileId = context?.profileId;
    if (!safeId(profileId) || !safeId(vacancyId) || !safeId(negotiationId))
      return { status: 400, body: { error: 'invalid_response_conversation_request' } };
    if (!isVacancyOwned(profileId, vacancyId)) return { status: 404, body: { error: 'conversation_not_found' } };
    let credential;
    try { credential = await loadCredential(profileId); }
    catch { return { status: 503, body: { error: 'hh_credential_unavailable' } }; }
    if (credential?.profileId !== profileId || typeof credential.accessToken !== 'string' || !credential.accessToken)
      return { status: 503, body: { error: 'hh_credential_unavailable' } };

    const request = async (token, url) => fetchImpl(url, { method: 'GET', headers: {
      authorization: `Bearer ${token}`, accept: 'application/json', 'HH-User-Agent': userAgent
    }, signal: AbortSignal.timeout(timeoutMs) });
    const providerGet = async url => {
      let response;
      try {
        response = await request(credential.accessToken, url);
        if (response.status === 401 && typeof refreshCredential === 'function') {
          const renewed = await refreshCredential(profileId, credential.accessToken);
          if (renewed?.profileId !== profileId || typeof renewed.accessToken !== 'string' || !renewed.accessToken)
            return { error: { status: 503, body: { error: 'hh_credential_unavailable' } } };
          credential = renewed;
          response = await request(credential.accessToken, url);
        }
      } catch { return { error: { status: 503, body: { error: 'hh_provider_unavailable' } } }; }
      if (response.status === 404) return { error: { status: 404, body: { error: 'conversation_not_found' } } };
      if (response.status === 401 || response.status === 403)
        return { error: { status: 503, body: { error: 'hh_authorization_required' } } };
      if (!response.ok) return { error: { status: 503, body: { error: 'hh_provider_unavailable' } } };
      try { return { data: await response.json() }; }
      catch { return { error: { status: 502, body: { error: 'hh_invalid_response' } } }; }
    };

    // Bind the exact negotiation to the server-owned vacancy before using chat_id.
    const detail = await providerGet(`https://api.hh.ru/negotiations/${encodeURIComponent(negotiationId)}`);
    if (detail.error) return detail.error;
    if (String(detail.data?.id ?? '') !== negotiationId || String(detail.data?.vacancy?.id ?? '') !== vacancyId)
      return { status: 404, body: { error: 'conversation_not_found' } };
    const chatId = String(detail.data?.chat_id ?? '');
    if (!safeId(chatId)) return { status: 409, body: { error: 'conversation_unavailable' } };
    const validatedChatId = chatId;

    // Reading HH chat history can change the response's viewed state. Persist
    // the attempt before that side effect, and fail closed if the audit is down.
    let attemptId = null;
    if (conversationAudit !== null) {
      try {
        attemptId = createAttemptId();
        await conversationAudit.start({ attemptId, profileId, vacancyId, negotiationId, chatId: validatedChatId });
      } catch { return { status: 503, body: { error: 'conversation_audit_unavailable' } }; }
    }
    const finishAudit = async outcome => {
      if (attemptId === null) return true;
      try { await conversationAudit.finish({ attemptId, outcome }); return true; }
      catch { return false; }
    };

    const chatUrl = new URL(`https://api.hh.ru/common/chats/${encodeURIComponent(validatedChatId)}/messages`);
    chatUrl.searchParams.set('order', 'prev');
    chatUrl.searchParams.set('limit', String(MAX_MESSAGES));
    const page = await providerGet(chatUrl);
    if (page.error) {
      if (!await finishAudit('failed')) return { status: 503, body: { error: 'conversation_audit_unavailable' } };
      return page.error;
    }
    const data = page.data;
    if (String(data?.id ?? '') !== validatedChatId || String(data?.vacancy_id ?? '') !== vacancyId ||
        !Array.isArray(data?.messages) || data.messages.length > MAX_MESSAGES || typeof data.has_more !== 'boolean')
      return await finishAudit('failed')
        ? { status: 502, body: { error: 'hh_invalid_response' } }
        : { status: 503, body: { error: 'conversation_audit_unavailable' } };
    const messages = data.messages.map(projectMessage);
    if (messages.some(message => message === null) || new Set(messages.map(message => message.id)).size !== messages.length)
      return await finishAudit('failed')
        ? { status: 502, body: { error: 'hh_invalid_response' } }
        : { status: 503, body: { error: 'conversation_audit_unavailable' } };
    if (!await finishAudit('completed')) return { status: 503, body: { error: 'conversation_audit_unavailable' } };
    return { status: 200, body: { domainApiVersion: 'v1', profileId, vacancyId, negotiationId,
      chatId: validatedChatId, messages, hasMore: data.has_more, pageLimit: MAX_MESSAGES,
      fetchedAt: clock().toISOString(), freshness: 'live_at_request', viewedEffect: 'may_mark_response_viewed' } };
  };
}
import { randomUUID } from 'node:crypto';
