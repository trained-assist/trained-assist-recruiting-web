// Explicit, scope-gated HH conversation read. Reading messages can mark a
// negotiation viewed, so callers must require recruiting.responses.conversation.open.
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const createdAt = value => typeof value === 'string' && !Number.isNaN(Date.parse(value))
  ? new Date(value).toISOString() : null;

export function createHhConversationRead({ loadCredential, refreshCredential, fetchImpl = globalThis.fetch,
  isVacancyOwned, userAgent, clock = () => new Date(), timeoutMs = 8_000, maxPages = 20 } = {}) {
  if (typeof loadCredential !== 'function' || typeof fetchImpl !== 'function' ||
      typeof isVacancyOwned !== 'function' || typeof clock !== 'function' ||
      typeof userAgent !== 'string' || userAgent.length < 3 || userAgent.length > 200 ||
      !/^[\x20-\x7e]+$/.test(userAgent) || !userAgent.includes('@') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
      !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100)
    throw new TypeError('HH conversation read ports required');

  return async (context, { vacancyId, negotiationId }) => {
    const profileId = context?.profileId;
    if (!safeId(profileId) || !safeId(vacancyId) || !safeId(negotiationId))
      return { status: 400, body: { error: 'invalid_conversation_request' } };
    if (!isVacancyOwned(profileId, vacancyId))
      return { status: 404, body: { error: 'conversation_not_found' } };
    let credential;
    try { credential = await loadCredential(profileId); }
    catch { return { status: 503, body: { error: 'hh_credential_unavailable' } }; }
    if (credential?.profileId !== profileId || typeof credential.accessToken !== 'string' || !credential.accessToken)
      return { status: 503, body: { error: 'hh_credential_unavailable' } };

    const request = async (url, token) => fetchImpl(url, { method: 'GET', headers: {
      authorization: `Bearer ${token}`, accept: 'application/json', 'HH-User-Agent': userAgent
    }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const withRefresh = async url => {
      let response = await request(url, credential.accessToken);
      if (response.status === 401 && typeof refreshCredential === 'function') {
        const renewed = await refreshCredential(profileId, credential.accessToken);
        if (renewed?.profileId !== profileId || typeof renewed.accessToken !== 'string' || !renewed.accessToken)
          return null;
        credential = renewed;
        response = await request(url, credential.accessToken);
      }
      return response;
    };
    let negotiation;
    try {
      const response = await withRefresh(`https://api.hh.ru/negotiations/${encodeURIComponent(negotiationId)}`);
      if (!response) return { status: 503, body: { error: 'hh_credential_unavailable' } };
      if (response.status === 404) return { status: 404, body: { error: 'conversation_not_found' } };
      if (response.status === 401 || response.status === 403 || !response.ok)
        return { status: 503, body: { error: 'hh_provider_unavailable' } };
      negotiation = await response.json();
    } catch { return { status: 503, body: { error: 'hh_provider_unavailable' } }; }
    const chatId = String(negotiation?.chat_id ?? '');
    if (String(negotiation?.id ?? '') !== negotiationId || String(negotiation?.vacancy?.id ?? '') !== vacancyId || !safeId(chatId))
      return { status: 404, body: { error: 'conversation_not_found' } };

    const messages = [];
    for (let page = 0; page < maxPages; page++) {
      let data;
      try {
        const url = new URL(`https://api.hh.ru/common/chats/${encodeURIComponent(chatId)}/messages`);
        url.searchParams.set('page', String(page));
        const response = await withRefresh(url.href);
        if (!response) return { status: 503, body: { error: 'hh_credential_unavailable' } };
        if (response.status === 404) return { status: 404, body: { error: 'conversation_not_found' } };
        if (response.status === 401 || response.status === 403 || !response.ok)
          return { status: 503, body: { error: 'hh_provider_unavailable' } };
        data = await response.json();
      } catch { return { status: 503, body: { error: 'hh_provider_unavailable' } }; }
      if (!Array.isArray(data?.messages)) return { status: 502, body: { error: 'hh_invalid_conversation' } };
      for (const raw of data.messages) {
        const id = String(raw?.id ?? '');
        const role = raw?.sender_display_info?.role;
        const text = raw?.payload?.text;
        const time = createdAt(raw?.creation_time);
        if (!safeId(id) || !['EMPLOYER', 'APPLICANT'].includes(role) || typeof text !== 'string' || !time)
          return { status: 502, body: { error: 'hh_invalid_conversation' } };
        messages.push({ id, role, text, createdAt: time });
      }
      if (data.has_more !== true) return { status: 200, body: { profileId, vacancyId, negotiationId, chatId,
        messages: messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)), fetchedAt: clock().toISOString() } };
    }
    return { status: 503, body: { error: 'conversation_history_too_large' } };
  };
}
