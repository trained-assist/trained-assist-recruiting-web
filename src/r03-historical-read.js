const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const value = (item, key) => typeof item?.[key] === 'string' ? item[key].slice(0, 500) : '';
const safeScore = item => item?.score !== null && item?.score !== undefined && item.score !== '' &&
  Number.isFinite(Number(item.score)) ? Number(item.score) : null;
const safeResumeUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru')) &&
      /^\/resume\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};

// The same transport-neutral read is used by the private HTTP routes and the
// offline MCP parity fixture. No candidate action or Agent Run port exists.
export function createR03HistoricalRead({ selected, isVacancyOwned }) {
  if (!(selected instanceof Map) || typeof isVacancyOwned !== 'function')
    throw new TypeError('historical_read_ports_required');
  const scope = (context, vacancyId) => safeId(context?.profileId) &&
    context.scopes?.includes('recruiting.candidateSearch') && safeId(vacancyId) &&
    isVacancyOwned(context.profileId, vacancyId) === true;
  const get = (context, vacancyId) => scope(context, vacancyId) ?
    selected.get(`${context.profileId}\0${vacancyId}`) : undefined;
  return {
    has: (context, vacancyId) => Boolean(get(context, vacancyId)),
    read: (context, vacancyId) => {
      if (!safeId(context?.profileId) || !context.scopes?.includes('recruiting.candidateSearch'))
        return { kind: 'denied' };
      if (!safeId(vacancyId)) return { kind: 'invalid' };
      if (!isVacancyOwned(context.profileId, vacancyId)) return { kind: 'not_found' };
      const row = get(context, vacancyId);
      if (!row) return { kind: 'not_found' };
      return { kind: 'found', value: { ok: true, vacancyId, status: 'historical_only',
        searchedAt: row.searchedAt, total: row.candidates.length,
        historicalRevision: row.historicalRevision,
        candidates: row.candidates.map(item => ({ id: item.id, title: value(item, 'title'),
          firstName: value(item, 'first_name'), lastName: value(item, 'last_name'),
          area: value(item.area, 'name'), score: safeScore(item),
          hhUrl: safeResumeUrl(value(item, 'hh_url')) })) } };
    }
  };
}
