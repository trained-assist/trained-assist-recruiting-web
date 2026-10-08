// Fetch the current state of one exact HH response without opening messages.
// HH documents that GET messages can mark a response viewed; this reader must
// never call a messages endpoint under recruiting.responses.read.
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const iso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;

export function createHhResponseDetailRead({ loadCredential, refreshCredential, fetchImpl,
  isVacancyOwned, userAgent, clock = () => new Date(), timeoutMs = 8_000 } = {}) {
  if (typeof loadCredential !== 'function' || typeof fetchImpl !== 'function' ||
      typeof isVacancyOwned !== 'function' || typeof clock !== 'function' ||
      typeof userAgent !== 'string' || userAgent.length < 3 || userAgent.length > 200 ||
      !/^[\x20-\x7e]+$/.test(userAgent) || !userAgent.includes('@') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
    throw new TypeError('HH response detail ports required');

  return async (context, { vacancyId, negotiationId }) => {
    const profileId = context?.profileId;
    if (!safeId(profileId) || !safeId(vacancyId) || !safeId(negotiationId))
      return { status: 400, body: { error: 'invalid_response_detail_request' } };
    if (!isVacancyOwned(profileId, vacancyId))
      return { status: 404, body: { error: 'response_detail_not_found' } };
    let credential;
    try { credential = await loadCredential(profileId); }
    catch { return { status: 503, body: { error: 'hh_credential_unavailable' } }; }
    if (credential?.profileId !== profileId || typeof credential.accessToken !== 'string' || !credential.accessToken)
      return { status: 503, body: { error: 'hh_credential_unavailable' } };

    const request = token => fetchImpl(`https://api.hh.ru/negotiations/${encodeURIComponent(negotiationId)}`, {
      method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json',
        'HH-User-Agent': userAgent }, signal: AbortSignal.timeout(timeoutMs) });
    let response;
    try {
      response = await request(credential.accessToken);
      if (response.status === 401 && typeof refreshCredential === 'function') {
        const renewed = await refreshCredential(profileId, credential.accessToken);
        if (renewed?.profileId !== profileId || typeof renewed.accessToken !== 'string' || !renewed.accessToken)
          return { status: 503, body: { error: 'hh_credential_unavailable' } };
        response = await request(renewed.accessToken);
      }
    } catch { return { status: 503, body: { error: 'hh_provider_unavailable' } }; }
    if (response.status === 404) return { status: 404, body: { error: 'response_detail_not_found' } };
    if (response.status === 401 || response.status === 403)
      return { status: 503, body: { error: 'hh_authorization_required' } };
    if (!response.ok) return { status: 503, body: { error: 'hh_provider_unavailable' } };
    let data;
    try { data = await response.json(); }
    catch { return { status: 502, body: { error: 'hh_invalid_response' } }; }
    const id = String(data?.id ?? '');
    const providerVacancyId = String(data?.vacancy?.id ?? '');
    const resumeId = String(data?.resume?.id ?? '');
    const state = data?.state?.id;
    if (id !== negotiationId || !safeId(providerVacancyId) || !safeId(resumeId) || !safeId(state))
      return { status: 502, body: { error: 'hh_invalid_response' } };
    if (providerVacancyId !== vacancyId)
      return { status: 404, body: { error: 'response_detail_not_found' } };
    return { status: 200, body: { domainApiVersion: 'v1', profileId, vacancyId,
      negotiationId, resumeId, state, updatedAt: iso(data.updated_at),
      fetchedAt: clock().toISOString(), freshness: 'live_at_request' } };
  };
}
