const LADDER_URL = 'https://llm-ladder.trainedassist.store/v1/chat/completions';
const fail = () => { throw new Error('service_ladder_unavailable'); };

// The host supplies its private service token and HTTP implementation. This
// adapter only speaks the approved service-ladder query-generation contract.
export function createServiceLadderChat({ loadToken, fetchImpl } = {}) {
  if (typeof loadToken !== 'function' || typeof fetchImpl !== 'function')
    throw new TypeError('service ladder credential and HTTP ports required');
  return async ({ messages, ladder, temperature, maxTokens, timeoutMs, source } = {}) => {
    if (ladder !== 'service' || temperature !== 0.3 || maxTokens !== 300 || timeoutMs !== 20_000 ||
        source !== 'hh-proactive' || !Array.isArray(messages) || messages.length !== 1 ||
        messages[0]?.role !== 'user' || typeof messages[0].content !== 'string' ||
        !messages[0].content || messages[0].content.length > 32_000) fail();
    let token;
    try { token = await loadToken(); } catch { fail(); }
    if (typeof token !== 'string' || !token || token.length > 16_000 || /\s/.test(token)) fail();
    let response;
    try {
      response = await fetchImpl(LADDER_URL, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'x-ladder-app': source },
        body: JSON.stringify({ model: ladder, messages, temperature, max_tokens: maxTokens,
          ladder_timeout_ms: timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + 20_000) });
    } catch { fail(); }
    if (!response?.ok || typeof response.json !== 'function') fail();
    let payload;
    try { payload = await response.json(); } catch { fail(); }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim() || content.length > 32_000) fail();
    return content;
  };
}
