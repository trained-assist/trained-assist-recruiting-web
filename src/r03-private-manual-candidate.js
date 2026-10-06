import { mapHhResumeCandidate } from './hh-resume-mapping.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));

function resumeId(value) {
  if (typeof value !== 'string') return null;
  if (/^[A-Za-z0-9]{1,128}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const match = /^\/resume\/([A-Za-z0-9]{1,128})\/?$/.exec(url.pathname);
    return url.protocol === 'https:' && ['hh.ru', 'www.hh.ru'].includes(url.hostname) &&
      !url.username && !url.password ? match?.[1] ?? null : null;
  } catch { return null; }
}

// A manually pasted resume is target-owned per vacancy. It never creates a
// search receipt, a wildcard membership, or a fake fresh morning search.
export function createR03PrivateManualCandidate({ candidateState, loadBasePlan, credentialBroker,
  isVacancyOwned, fetchImpl, clock = () => new Date() } = {}) {
  if (typeof candidateState?.hasManualCandidate !== 'function' ||
      typeof candidateState?.addManualCandidate !== 'function' || typeof loadBasePlan !== 'function' ||
      typeof credentialBroker?.loadCredential !== 'function' ||
      typeof credentialBroker?.refreshCredential !== 'function' ||
      typeof isVacancyOwned !== 'function' || typeof fetchImpl !== 'function' || typeof clock !== 'function')
    throw new TypeError('manual_candidate_ports_required');
  return async (context, command) => {
    if (!exact(command, ['vacancy_id', 'resume_url_or_id']) || !safeId(command.vacancy_id))
      return { status: 400, body: { error: 'invalid_manual_candidate_request' } };
    const id = resumeId(command.resume_url_or_id);
    if (!id) return { status: 400, body: { error: 'invalid_hh_resume_id' } };
    const { profileId } = context ?? {};
    const vacancyId = command.vacancy_id;
    if (!safeId(profileId) || !context.scopes?.includes('recruiting.candidateSearch') ||
        !isVacancyOwned(profileId, vacancyId)) return { status: 404, body: { error: 'vacancy_not_found' } };
    if (candidateState.hasManualCandidate(profileId, vacancyId, id))
      return { status: 200, body: { ok: true, added: false, candidateId: id } };
    let plan, credential;
    try {
      plan = await loadBasePlan(profileId, vacancyId, { allowGeneration: false });
      credential = await credentialBroker.loadCredential(profileId);
      if (plan?.profileId !== profileId || plan?.vacancyId !== vacancyId ||
          credential?.profileId !== profileId || !credential.accessToken) throw new Error('unbound');
    } catch { return { status: 503, body: { error: 'manual_candidate_dependency_unavailable' } }; }
    let token = credential.accessToken;
    let refreshed = false;
    let raw;
    for (;;) {
      let response;
      try { response = await fetchImpl(`https://api.hh.ru/resumes/${encodeURIComponent(id)}`, {
        method: 'GET', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'trained-assist-recruiting-web/1.0',
          'HH-User-Agent': 'trained-assist-recruiting-web/1.0' } }); }
      catch { return { status: 503, body: { error: 'hh_resume_unavailable' } }; }
      if ([401, 403].includes(response?.status) && !refreshed) {
        refreshed = true;
        try {
          const next = await credentialBroker.refreshCredential(profileId, token);
          if (next?.profileId !== profileId || !next.accessToken) throw new Error('unbound');
          token = next.accessToken;
        } catch { return { status: 503, body: { error: 'hh_credential_unavailable' } }; }
        continue;
      }
      if (!response?.ok || typeof response.json !== 'function')
        return { status: response?.status === 404 ? 404 : 503,
          body: { error: response?.status === 404 ? 'hh_resume_not_found' : 'hh_resume_unavailable' } };
      if (Number(response.headers?.get?.('content-length') ?? 0) > 2_000_000)
        return { status: 502, body: { error: 'hh_resume_invalid' } };
      try { raw = await response.json(); }
      catch { return { status: 502, body: { error: 'hh_resume_invalid' } }; }
      break;
    }
    if (raw?.id !== id || Buffer.byteLength(JSON.stringify(raw)) > 2_000_000)
      return { status: 502, body: { error: 'hh_resume_invalid' } };
    let candidate;
    try {
      const mapped = mapHhResumeCandidate(raw, plan.atsConfig, vacancyId, { bypassMinExperience: true });
      if (mapped.kind !== 'candidate') throw new Error('invalid');
      candidate = mapped.candidate;
    } catch { return { status: 502, body: { error: 'hh_resume_invalid' } }; }
    try {
      const stored = candidateState.addManualCandidate({ profileId, vacancyId, candidate,
        addedAt: clock().toISOString() });
      return { status: stored.added ? 201 : 200, body: { ok: true, added: stored.added, candidateId: id } };
    } catch { return { status: 503, body: { error: 'manual_candidate_unavailable' } }; }
  };
}
