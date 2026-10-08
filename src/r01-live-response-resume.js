import { createHash } from 'node:crypto';
import { mapHhResumeCandidate, mapHhResumeClientSections } from './hh-resume-mapping.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const fail = (status, error) => ({ status, body: { error } });

/** Read one current HH resume for an exact owned response; never reads messages. */
export function createHhResponseResumeRead({ loadCredential, refreshCredential, fetchImpl,
  loadBasePlan, isVacancyOwned, userAgent, timeoutMs = 20_000 } = {}) {
  if (typeof loadCredential !== 'function' || typeof refreshCredential !== 'function' ||
      typeof fetchImpl !== 'function' || typeof loadBasePlan !== 'function' ||
      typeof isVacancyOwned !== 'function' || typeof userAgent !== 'string' ||
      userAgent.length < 3 || userAgent.length > 200 || !/^[\x20-\x7e]+$/.test(userAgent) ||
      !userAgent.includes('@') || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
    throw new TypeError('HH response resume ports required');

  return async (context, { vacancyId, resumeId } = {}) => {
    const profileId = context?.profileId;
    if (![profileId, vacancyId, resumeId].every(value => SAFE_ID.test(value ?? '')) ||
        !context.scopes?.includes('recruiting.reports.read')) return fail(404, 'resume_not_found');
    if (!isVacancyOwned(profileId, vacancyId)) return fail(404, 'vacancy_not_found');
    let plan;
    try { plan = await loadBasePlan(profileId, vacancyId, { allowGeneration: false }); }
    catch { return fail(503, 'resume_source_unavailable'); }
    if (plan?.profileId !== profileId || plan?.vacancyId !== vacancyId ||
        typeof plan.criteriaRevision !== 'string' || !plan.criteriaRevision ||
        !plan.atsConfig || typeof plan.atsConfig !== 'object') return fail(409, 'candidate_criteria_stale');

    let credential;
    try { credential = await loadCredential(profileId); }
    catch { return fail(503, 'hh_credential_unavailable'); }
    if (credential?.profileId !== profileId || typeof credential.accessToken !== 'string' || !credential.accessToken)
      return fail(503, 'hh_credential_unavailable');

    let token = credential.accessToken;
    let refreshed = false;
    let response;
    for (;;) {
      try {
        response = await fetchImpl(`https://api.hh.ru/resumes/${encodeURIComponent(resumeId)}`, {
          method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent, 'HH-User-Agent': userAgent,
            Accept: 'application/json' },
        });
      } catch { return fail(503, 'hh_resume_unavailable'); }
      if ([401, 403].includes(response?.status) && !refreshed) {
        refreshed = true;
        try {
          const next = await refreshCredential(profileId, token);
          if (next?.profileId !== profileId || typeof next.accessToken !== 'string' || !next.accessToken)
            throw new Error('credential_mismatch');
          token = next.accessToken;
        } catch { return fail(503, 'hh_credential_unavailable'); }
        continue;
      }
      break;
    }
    if (response?.status === 404) return fail(404, 'resume_not_found');
    if (response?.status === 401 || response?.status === 403 || !response?.ok || typeof response.json !== 'function')
      return fail(503, 'hh_resume_unavailable');
    if (Number(response.headers?.get?.('content-length') ?? 0) > 2_000_000)
      return fail(502, 'hh_resume_invalid');
    let raw;
    try { raw = await response.json(); }
    catch { return fail(502, 'hh_resume_invalid'); }
    let bytes;
    try { bytes = JSON.stringify(raw); }
    catch { return fail(502, 'hh_resume_invalid'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.id !== resumeId ||
        Buffer.byteLength(bytes) > 2_000_000) return fail(502, 'hh_resume_invalid');
    let mapped;
    try { mapped = mapHhResumeCandidate(raw, plan.atsConfig, vacancyId, { bypassMinExperience: true }); }
    catch { return fail(502, 'hh_resume_invalid'); }
    if (mapped.kind !== 'candidate' || mapped.candidate.id !== resumeId)
      return fail(502, 'hh_resume_invalid');
    const resume = { firstName: mapped.candidate.firstName, lastName: mapped.candidate.lastName,
      title: mapped.candidate.title, experience: mapped.candidate.experience,
      ...mapHhResumeClientSections(raw) };
    return { status: 200, body: { profileId, vacancyId, resumeId,
      sourceRevision: createHash('sha256').update(bytes).digest('hex'), criteriaRevision: plan.criteriaRevision,
      resume, candidateProjection: mapped.candidate } };
  };
}
