// HH resume search boundary. No ambient fetch, profile files, or credentials are read here.
const HH_RESUMES_URL = 'https://api.hh.ru/resumes';
const MAX_PAGES = 40;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class HhSearchError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = 'HhSearchError';
    this.code = code;
    this.status = status;
  }
}

const has = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

// The precedence and explicit unrestricted null match hh-cold-search-transport.js.
export function resolveHhSearchAreas(config, vacancy, options = {}) {
  let area;
  if (has(options, 'area')) area = options.area;
  else if (has(config?.filters, 'area')) area = config.filters.area;
  else if (has(config, 'area')) area = config.area;
  else if (has(vacancy, 'area')) area = vacancy.area;
  else throw new HhSearchError('area_missing');
  if (area === null) return [];
  const values = Array.isArray(area) ? area : [area];
  if (!values.length) return [];
  const ids = values.map(value => String(value?.id ?? value));
  if (ids.some(value => !/^\d+$/.test(value))) throw new HhSearchError('area_invalid');
  return [...new Set(ids)];
}

function requireBoundCredential(value, profileId) {
  if (!value || value.profileId !== profileId || typeof value.accessToken !== 'string' || !value.accessToken.trim()) {
    throw new HhSearchError('credential_unavailable');
  }
  return value.accessToken;
}

function requireBoundContext(value, profileId, vacancyId) {
  if (!value || value.profileId !== profileId || String(value.vacancyId) !== vacancyId ||
      !value.config || typeof value.config !== 'object' ||
      (has(value.config, 'vacancy_id') && String(value.config.vacancy_id) !== vacancyId)) {
    throw new HhSearchError('vacancy_context_unavailable');
  }
  return value;
}

export function createHhResumeTransport({ loadVacancyContext, loadCredential, refreshCredential,
  fetchImpl, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 20_000 } = {}) {
  if (typeof loadVacancyContext !== 'function' || typeof loadCredential !== 'function') throw new TypeError('trusted context and credential ports required');
  if (typeof fetchImpl !== 'function') throw new TypeError('explicit fetch adapter required');
  if (refreshCredential !== undefined && typeof refreshCredential !== 'function') throw new TypeError('invalid refresh port');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('invalid timeout');

  return {
    async search({ trustedContext, vacancyId, query, ...options } = {}) {
      const profileId = trustedContext?.profileId;
      if (typeof profileId !== 'string' || !SAFE_ID.test(profileId) ||
          !Array.isArray(trustedContext.scopes) || !trustedContext.scopes.includes('recruiting.candidateSearch')) {
        throw new HhSearchError('profile_denied');
      }
      if (typeof vacancyId !== 'string' || !SAFE_ID.test(vacancyId)) throw new HhSearchError('vacancy_invalid');
      if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new HhSearchError('query_invalid');
      let loadedContext;
      try { loadedContext = await loadVacancyContext(profileId, vacancyId); }
      catch { throw new HhSearchError('vacancy_context_unavailable'); }
      const context = requireBoundContext(loadedContext, profileId, vacancyId);
      const areas = resolveHhSearchAreas(context.config, context.vacancy, options);
      let loadedCredential;
      try { loadedCredential = await loadCredential(profileId); }
      catch { throw new HhSearchError('credential_unavailable'); }
      let accessToken = requireBoundCredential(loadedCredential, profileId);
      const params = new URLSearchParams({ text: query, page: '0', per_page: '50', order_by: 'relevance' });
      for (const area of areas) params.append('area', area);
      let refreshed = false;
      const items = [];
      let expectedPages = null;
      let found = null;
      for (let page = 0; page < (expectedPages ?? 1); page++) {
        params.set('page', String(page));
        let retries = 0;
        for (;;) {
        let response;
        try {
          response = await fetchImpl(`${HH_RESUMES_URL}?${params}`, {
            method: 'GET', signal: AbortSignal.timeout(timeoutMs),
            headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'trained-assist-recruiting-web/1.0', 'HH-User-Agent': 'trained-assist-recruiting-web/1.0' }
          });
        } catch (error) {
          const transient = error?.name === 'TimeoutError' || error?.name === 'AbortError' || error instanceof TypeError;
          if (transient && retries < 2) { await sleep(500 * 2 ** retries++); continue; }
          throw new HhSearchError('provider_unavailable');
        }
        if (!response || !Number.isInteger(response.status) || typeof response.ok !== 'boolean' || typeof response.json !== 'function') {
          throw new HhSearchError('provider_invalid_response');
        }
        if ((response.status === 401 || response.status === 403) && !refreshed && refreshCredential) {
          refreshed = true;
          let next;
          try { next = await refreshCredential(profileId, accessToken); }
          catch { throw new HhSearchError('credential_unavailable'); }
          accessToken = requireBoundCredential(next, profileId);
          continue;
        }
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500 && response.status <= 599) && retries < 2) {
            await sleep(500 * 2 ** retries++);
            continue;
          }
          throw new HhSearchError(response.status === 401 ? 'provider_unauthorized' :
            response.status === 403 ? 'provider_forbidden' :
            response.status === 429 || response.status >= 500 ? 'provider_unavailable' : 'provider_error', response.status);
        }
        let data;
        try { data = await response.json(); }
        catch { throw new HhSearchError('provider_invalid_response'); }
        if (!data || !Array.isArray(data.items) || data.items.length > 50 ||
            data.pages !== undefined && (!Number.isSafeInteger(data.pages) || data.pages < 0) ||
            data.found !== undefined && (!Number.isSafeInteger(data.found) || data.found < 0))
          throw new HhSearchError('provider_invalid_response');
        const pages = data.pages ?? 1;
        if (pages === 0 && (page !== 0 || data.items.length !== 0)) throw new HhSearchError('provider_invalid_response');
        if (pages > MAX_PAGES) throw new HhSearchError('provider_result_window_exceeded');
        if (expectedPages !== null && pages !== expectedPages) throw new HhSearchError('provider_page_count_changed');
        expectedPages = pages;
        found ??= data.found ?? null;
        items.push(...data.items);
        break;
        }
      }
      return { profileId, vacancyId, areas, items, found, pages: expectedPages };
    }
  };
}
