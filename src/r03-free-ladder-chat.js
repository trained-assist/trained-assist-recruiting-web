const LADDER_URL = 'https://llm-ladder.trainedassist.store/v1/chat/completions';
const fail = () => { throw new Error('free_ladder_unavailable'); };

// ATS assessment uses the old HH skill's free ladder; the host owns the token.
export function createFreeLadderChat({ loadToken, fetchImpl } = {}) {
  if (typeof loadToken !== 'function' || typeof fetchImpl !== 'function')
    throw new TypeError('free ladder credential and HTTP ports required');
  return async ({ messages, ladder, temperature, maxTokens, timeoutMs, source } = {}) => {
    if (ladder !== 'free' || temperature !== 0.1 || maxTokens !== 600 || timeoutMs !== 25_000 ||
        source !== 'hh-enrich' || !Array.isArray(messages) || messages.length !== 1 ||
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
