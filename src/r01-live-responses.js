import { createHash } from 'node:crypto';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const iso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;

// HH is the authority for this read. Never accept a token, profile or HH URL
// from the request; the host supplies the credential broker and binding.
export function createHhResponseRead({ loadCredential, refreshCredential, fetchImpl, isVacancyOwned,
  clock = () => new Date(), timeoutMs = 8_000 } = {}) {
  if (typeof loadCredential !== 'function' || typeof fetchImpl !== 'function' ||
      typeof isVacancyOwned !== 'function' || typeof clock !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
    throw new TypeError('HH response read ports required');

  return async (context, { vacancyId, page = 0 }) => {
    const profileId = context?.profileId;
    if (!safeId(profileId) || !safeId(vacancyId) || !Number.isInteger(page) || page < 0 || page > 500)
      return { status: 400, body: { error: 'invalid_response_request' } };
    if (!isVacancyOwned(profileId, vacancyId))
      return { status: 404, body: { error: 'vacancy_not_found' } };

    let credential;
    try { credential = await loadCredential(profileId); }
    catch { return { status: 503, body: { error: 'hh_credential_unavailable' } }; }
    if (credential?.profileId !== profileId || typeof credential.accessToken !== 'string' || !credential.accessToken)
      return { status: 503, body: { error: 'hh_credential_unavailable' } };

    const url = new URL('https://api.hh.ru/negotiations/response');
    url.searchParams.set('vacancy_id', vacancyId);
    url.searchParams.set('per_page', '20');
    url.searchParams.set('page', String(page));
    const request = async token => fetchImpl(url, { method: 'GET', headers: {
      authorization: `Bearer ${token}`, accept: 'application/json'
    }, signal: AbortSignal.timeout(timeoutMs) });
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
    if (response.status === 401 || response.status === 403)
      return { status: 503, body: { error: 'hh_authorization_required' } };
    if (!response.ok) return { status: 503, body: { error: 'hh_provider_unavailable' } };

    let data;
    try { data = await response.json(); }
    catch { return { status: 502, body: { error: 'hh_invalid_response' } }; }
    if (!data || !Array.isArray(data.items) || !Number.isInteger(data.found) || data.found < 0 ||
        !Number.isInteger(data.pages) || data.pages < 0 || data.pages > 501 ||
        !Number.isInteger(data.page) || data.page !== page || data.items.length > 20 ||
        data.items.length > data.found || data.items.length > 0 && data.pages === 0)
      return { status: 502, body: { error: 'hh_invalid_response' } };
    const ids = new Set();
    const items = [];
    for (const neg of data.items) {
      const id = String(neg?.id ?? '');
      const resumeId = String(neg?.resume?.id ?? '');
      const receivedAt = iso(neg?.created_at);
      if (!safeId(id) || !safeId(resumeId) || !receivedAt || ids.has(id) ||
          neg?.state?.id !== 'response' || neg?.vacancy?.id !== undefined && String(neg.vacancy.id) !== vacancyId)
        return { status: 502, body: { error: 'hh_invalid_response' } };
      ids.add(id);
      items.push({ id, resumeId, state: 'response', receivedAt,
        updatedAt: iso(neg.updated_at) ?? receivedAt,
        name: [neg.resume.last_name, neg.resume.first_name].filter(x => typeof x === 'string').join(' ').slice(0, 300),
        title: typeof neg.resume.title === 'string' ? neg.resume.title.slice(0, 300) : '' });
    }
    const sourceRevision = createHash('sha256').update(JSON.stringify({ vacancyId, page,
      found: data.found, pages: data.pages, items })).digest('hex');
    return { status: 200, body: { domainApiVersion: 'v1', profileId, vacancyId, state: 'response',
      page, total: data.found, pages: data.pages, items, sourceRevision,
      fetchedAt: clock().toISOString(), freshness: 'live_at_request', paginationConsistency: 'best_effort' } };
  };
}
