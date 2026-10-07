const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// One transport-neutral domain read for HTTP and an eventual MCP adapter.
// The trusted profile context is supplied by the host, never by tool input.
export function createRealProactiveRead({ feed, resolveVacancyOwnership }) {
  if (typeof feed?.read !== 'function' || typeof resolveVacancyOwnership !== 'function')
    throw new TypeError('real proactive read ports required');
  return async function read(trustedContext, vacancyId) {
    if (!safeId(trustedContext?.profileId) || !trustedContext.scopes?.includes('recruiting.candidateSearch'))
      return { kind: 'denied' };
    if (!safeId(vacancyId)) return { kind: 'invalid' };
    let owned;
    try { owned = await resolveVacancyOwnership(trustedContext, vacancyId); }
    catch { return { kind: 'unavailable' }; }
    if (owned !== true) return { kind: 'not_found' };
    let result;
    try { result = await feed.read(trustedContext, vacancyId); }
    catch { return { kind: 'unavailable' }; }
    return { kind: 'found', feed: result, value: { ok: true, vacancyId, status: result.status,
      freshness: result.freshness, total: result.total, candidates: result.items,
      resultRevision: result.resultRevision } };
  };
}
