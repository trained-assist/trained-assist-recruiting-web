import { createHash } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
const fail = (status, error) => ({ status, body: { error } });
const text = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;

function clientFields(resume, vacancyTitle) {
  const candidateName = [resume.firstName, resume.lastName].filter(Boolean).join(' ').trim();
  if (!text(candidateName, 300) || !text(resume.title, 300) || !text(vacancyTitle, 300) ||
      !Array.isArray(resume.experience) || resume.experience.length > 5) return null;
  const experience = [];
  for (const item of resume.experience) {
    if (!item || !text(item.position, 300) || !text(item.company, 500) || !text(item.start, 100) ||
        item.end !== null && !text(item.end, 100)) return null;
    experience.push({ role: item.position, company: item.company,
      period: item.end ? `${item.start} — ${item.end}` : `${item.start} — настоящее время` });
  }
  const safeList = (value, maxItems, maxLength) => Array.isArray(value)
    ? value.slice(0, maxItems).filter(item => text(item, maxLength) && item.trim()).map(item => item.trim()) : [];
  return { candidateName, position: resume.title, vacancyTitle, experience,
    education: safeList(resume.education, 10, 300), courses: safeList(resume.courses, 20, 300),
    skills: safeList(resume.skills, 30, 100), languages: safeList(resume.languages, 20, 150),
    location: text(resume.location, 200) ? resume.location.trim() : null };
}

/**
 * Report source for a candidate identified by an exact HH negotiation. This
 * deliberately reads negotiation state and resume only; it never opens messages.
 * A current accepted ATS assessment must already exist for this resume/revision.
 */
export function createHhResponseReportSourceRead({ readResponseDetail, readResume, loadBasePlan,
  loadAcceptedAssessment, isVacancyOwned } = {}) {
  if (typeof readResponseDetail !== 'function' || typeof readResume !== 'function' ||
      typeof loadBasePlan !== 'function' || typeof loadAcceptedAssessment !== 'function' ||
      typeof isVacancyOwned !== 'function') throw new TypeError('hh_response_report_source_ports_required');

  return async (context, { vacancyId, candidateId, sourceKind = 'accepted_hh_response' } = {}) => {
    const profileId = context?.profileId;
    if (sourceKind !== 'accepted_hh_response' || !SAFE_ID.test(profileId ?? '') ||
        !SAFE_ID.test(vacancyId ?? '') || !SAFE_ID.test(candidateId ?? '') ||
        !context.scopes?.includes('recruiting.reports.read')) return fail(404, 'candidate_not_found');
    if (!isVacancyOwned(profileId, vacancyId)) return fail(404, 'vacancy_not_found');

    try {
      const detail = await readResponseDetail(context, { vacancyId, negotiationId: candidateId });
      if (detail?.status !== 200 || detail.body?.profileId !== profileId ||
          detail.body?.vacancyId !== vacancyId || detail.body?.negotiationId !== candidateId ||
          detail.body?.state !== 'response' || !SAFE_ID.test(detail.body?.resumeId ?? ''))
        return fail(detail?.status === 404 ? 404 : detail?.status === 409 ? 409 : 503,
          detail?.status === 409 ? 'candidate_source_stale' : 'candidate_not_found');
      const resume = await readResume(context, { vacancyId, resumeId: detail.body.resumeId });
      if (resume?.status !== 200 || resume.body?.profileId !== profileId || resume.body?.vacancyId !== vacancyId ||
          resume.body?.resumeId !== detail.body.resumeId || !SHA.test(resume.body?.sourceRevision ?? '') ||
          resume.body?.candidateProjection?.id !== detail.body.resumeId ||
          resume.body?.candidateProjection?.vacancyId !== vacancyId)
        return fail(resume?.status === 409 ? 409 : resume?.status === 404 ? 404 : 503,
          resume?.status === 409 ? 'candidate_source_stale' : 'report_source_unavailable');

      const plan = await loadBasePlan(profileId, vacancyId, { allowGeneration: false });
      if (plan?.profileId !== profileId || plan?.vacancyId !== vacancyId ||
          typeof plan.criteriaRevision !== 'string' || !plan.criteriaRevision ||
          !text(plan.atsConfig?.vacancy_title, 300)) return fail(409, 'candidate_criteria_stale');
      const assessment = await loadAcceptedAssessment(profileId, vacancyId, detail.body.resumeId,
        { negotiationId: candidateId, criteriaRevision: plan.criteriaRevision,
          resumeRevision: resume.body.sourceRevision, candidateProjection: resume.body.candidateProjection });
      if (!assessment || assessment.profileId !== profileId || assessment.vacancyId !== vacancyId ||
          assessment.resumeId !== detail.body.resumeId || assessment.criteriaRevision !== plan.criteriaRevision ||
          assessment.resumeRevision !== resume.body.sourceRevision ||
          !SAFE_ID.test(assessment.assessmentRevision ?? '') ||
          !Number.isFinite(assessment.atsScore) || assessment.atsScore < 0 || assessment.atsScore > 10 ||
          !['PASS', 'REVIEW', 'WEAK'].includes(assessment.atsTag) ||
          !['active', 'starred'].includes(assessment.reviewStatus) ||
          !Number.isSafeInteger(assessment.reviewRevision) || assessment.reviewRevision < 0)
        return fail(409, 'candidate_assessment_incomplete');

      const fields = clientFields(resume.body.resume, plan.atsConfig.vacancy_title);
      if (!fields) return fail(502, 'invalid_report_source');
      // Re-read all three mutable authorities around projection. No message API
      // is present in this module's ports, so list/detail loading cannot mark viewed.
      const [detailAfter, resumeAfter, planAfter, assessmentAfter] = await Promise.all([
        readResponseDetail(context, { vacancyId, negotiationId: candidateId }),
        readResume(context, { vacancyId, resumeId: detail.body.resumeId }),
        loadBasePlan(profileId, vacancyId, { allowGeneration: false }),
        loadAcceptedAssessment(profileId, vacancyId, detail.body.resumeId,
          { negotiationId: candidateId, criteriaRevision: plan.criteriaRevision,
            resumeRevision: resume.body.sourceRevision, candidateProjection: resume.body.candidateProjection }),
      ]);
      if (detailAfter?.status !== 200 || detailAfter.body?.profileId !== profileId ||
          detailAfter.body?.vacancyId !== vacancyId || detailAfter.body?.negotiationId !== candidateId ||
          detailAfter.body?.resumeId !== detail.body.resumeId || detailAfter.body?.state !== 'response' ||
          resumeAfter?.status !== 200 || resumeAfter.body?.sourceRevision !== resume.body.sourceRevision ||
          JSON.stringify(resumeAfter.body?.candidateProjection) !== JSON.stringify(resume.body.candidateProjection) ||
          planAfter?.profileId !== profileId || planAfter?.vacancyId !== vacancyId ||
          planAfter?.criteriaRevision !== plan.criteriaRevision ||
          assessmentAfter?.profileId !== profileId || assessmentAfter?.vacancyId !== vacancyId ||
          assessmentAfter?.resumeId !== detail.body.resumeId ||
          assessmentAfter?.resumeRevision !== resume.body.sourceRevision ||
          assessmentAfter?.criteriaRevision !== plan.criteriaRevision ||
          assessmentAfter?.assessmentRevision !== assessment.assessmentRevision ||
          assessmentAfter?.atsScore !== assessment.atsScore || assessmentAfter?.atsTag !== assessment.atsTag ||
          assessmentAfter?.reviewRevision !== assessment.reviewRevision ||
          assessmentAfter?.reviewStatus !== assessment.reviewStatus)
        return fail(409, 'candidate_source_stale');

      const sourceRevision = createHash('sha256').update(JSON.stringify({ profileId, vacancyId,
        negotiationId: candidateId, resumeId: detail.body.resumeId,
        negotiationState: detail.body.state, responseUpdatedAt: detail.body.updatedAt,
        resumeRevision: resume.body.sourceRevision, criteriaRevision: plan.criteriaRevision,
        atsScore: assessment.atsScore, atsTag: assessment.atsTag,
        assessmentRevision: assessment.assessmentRevision, reviewStatus: assessment.reviewStatus,
        reviewRevision: assessment.reviewRevision })).digest('hex');
      return { status: 200, body: { domainApiVersion: 'v1', profileId, vacancyId,
        candidateId, sourceRevision, sourceKind: 'accepted_hh_response', publication: 'disabled',
        clientDraftFields: fields, internalAssessment: { atsScore: assessment.atsScore,
          atsTag: assessment.atsTag, reviewStatus: assessment.reviewStatus,
          reviewRevision: assessment.reviewRevision, criteriaRevision: plan.criteriaRevision } } };
    } catch { return fail(503, 'report_source_unavailable'); }
  };
}
