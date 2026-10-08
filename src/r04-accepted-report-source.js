import { createHash } from 'node:crypto';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = (status, error) => ({ status, body: { error } });
const short = (value, max) => typeof value === 'string' && value.length <= max ? value : null;
const sha256 = /^[a-f0-9]{64}$/;

function matchesAcceptedResume(acceptedCandidate, result, profileId, vacancyId, candidateId, criteriaRevision) {
  const body = result?.body;
  const projection = body?.candidateProjection;
  const resume = body?.resume;
  return result?.status === 200 && body?.profileId === profileId && body?.vacancyId === vacancyId &&
    body?.resumeId === candidateId && sha256.test(body?.sourceRevision ?? '') &&
    body?.criteriaRevision === criteriaRevision && projection?.id === candidateId &&
    projection?.vacancyId === vacancyId && projection?.firstName === acceptedCandidate.firstName &&
    projection?.lastName === acceptedCandidate.lastName && projection?.title === acceptedCandidate.title &&
    projection?.area === acceptedCandidate.area &&
    projection?.totalExperienceMonths === acceptedCandidate.totalExperienceMonths &&
    JSON.stringify(projection?.experience) === JSON.stringify(acceptedCandidate.experience) &&
    resume?.firstName === acceptedCandidate.firstName && resume?.lastName === acceptedCandidate.lastName &&
    resume?.title === acceptedCandidate.title &&
    JSON.stringify(resume?.experience) === JSON.stringify(acceptedCandidate.experience) &&
    Array.isArray(resume.education) && Array.isArray(resume.courses) && Array.isArray(resume.skills) &&
    Array.isArray(resume.languages) && (resume.location === null || typeof resume.location === 'string');
}

// Only accepted cold-search snapshots with a current ATS assessment can become
// report source proposals. This read does not create, approve or publish a report.
export function createAcceptedReportSourceRead({ feed, candidateState, loadBasePlan, readResume, isVacancyOwned } = {}) {
  if (typeof feed?.read !== 'function' || typeof candidateState?.latestSnapshot !== 'function' ||
      typeof candidateState?.assessmentForLatest !== 'function' || typeof loadBasePlan !== 'function' ||
      typeof readResume !== 'function' || typeof isVacancyOwned !== 'function') throw new TypeError('report source ports required');
  return async (context, { vacancyId, candidateId } = {}) => {
    const profileId = context?.profileId;
    if (!safeId(profileId) || !safeId(vacancyId) || !safeId(candidateId))
      return fail(400, 'invalid_report_source_request');
    if (!isVacancyOwned(profileId, vacancyId)) return fail(404, 'vacancy_not_found');
    const feedContext = { profileId, scopes: ['recruiting.candidateSearch'] };
    let first, snapshot, assessment, plan;
    try {
      first = feed.read(feedContext, vacancyId);
      const candidates = first.items.filter(item => item.id === candidateId);
      if (candidates.length !== 1) return fail(404, 'candidate_not_found');
      const candidate = candidates[0];
      if (candidate.vacancyId !== vacancyId || !safeId(candidate.jobId) ||
          !['active', 'starred'].includes(candidate.review?.status))
        return fail(409, 'candidate_not_reportable');
      snapshot = candidateState.latestSnapshot(profileId, vacancyId);
      if (!snapshot || snapshot.jobId !== candidate.jobId) return fail(409, 'candidate_source_stale');
      assessment = candidateState.assessmentForLatest({ profileId, vacancyId,
        jobId: candidate.jobId, candidateId });
      if (assessment.kind !== 'scored') return fail(409, 'candidate_assessment_incomplete');
      plan = await loadBasePlan(profileId, vacancyId, { allowGeneration: false });
      if (plan?.profileId !== profileId || plan.vacancyId !== vacancyId ||
          plan.criteriaRevision !== snapshot.criteriaRevision)
        return fail(409, 'candidate_criteria_stale');
      const vacancyTitle = short(plan.atsConfig?.vacancy_title, 300);
      const name = [candidate.firstName, candidate.lastName].filter(Boolean).join(' ');
      if (!vacancyTitle || !short(name, 300) || !short(candidate.title, 300) ||
          !Array.isArray(candidate.experience) || candidate.experience.length > 5 ||
          candidate.experience.some(row => !short(row.position, 300) || !short(row.company, 300) ||
            !short(row.start, 100) || row.end !== null && !short(row.end, 100)) ||
          typeof assessment.assessment?.atsScore !== 'number' ||
          !Number.isFinite(assessment.assessment.atsScore) || assessment.assessment.atsScore < 0 ||
          assessment.assessment.atsScore > 10 ||
          !['PASS', 'REVIEW', 'WEAK'].includes(assessment.assessment.atsTag) ||
          candidate.atsScore !== assessment.assessment.atsScore ||
          candidate.atsTag !== assessment.assessment.atsTag ||
          !Number.isSafeInteger(candidate.review.revision) || candidate.review.revision < 0)
        return fail(502, 'invalid_report_source');
      const resumeResult = await readResume(context, { vacancyId, resumeId: candidateId });
      if (resumeResult?.status !== 200)
        return fail(resumeResult?.status === 404 ? 404 : resumeResult?.status === 409 ? 409 : 503,
          resumeResult?.status === 404 ? 'candidate_not_found' : resumeResult?.status === 409 ? 'candidate_source_stale' : 'report_source_unavailable');
      if (!assessment.candidate || assessment.candidate.id !== candidateId || assessment.candidate.vacancyId !== vacancyId ||
          !matchesAcceptedResume(assessment.candidate, resumeResult, profileId, vacancyId, candidateId, snapshot.criteriaRevision))
        return fail(409, 'candidate_source_stale');
      const second = feed.read(feedContext, vacancyId);
      const currentPlan = await loadBasePlan(profileId, vacancyId, { allowGeneration: false });
      const resumeAfter = await readResume(context, { vacancyId, resumeId: candidateId });
      if (second.resultRevision !== first.resultRevision ||
          candidateState.latestSnapshot(profileId, vacancyId)?.jobId !== snapshot.jobId ||
          currentPlan?.criteriaRevision !== snapshot.criteriaRevision ||
          resumeAfter?.status !== 200 || resumeAfter.body?.sourceRevision !== resumeResult.body.sourceRevision ||
          !matchesAcceptedResume(assessment.candidate, resumeAfter, profileId, vacancyId, candidateId, snapshot.criteriaRevision))
        return fail(409, 'candidate_source_stale');
      const sourceRevision = createHash('sha256').update(JSON.stringify({ profileId, vacancyId, candidateId,
        feedRevision: first.resultRevision, jobId: snapshot.jobId, snapshotRevision: snapshot.resultRevision,
        criteriaRevision: snapshot.criteriaRevision, resumeRevision: resumeResult.body.sourceRevision,
        assessment: assessment.assessment,
        reviewRevision: candidate.review.revision })).digest('hex');
      return { status: 200, body: { domainApiVersion: 'v1', profileId, vacancyId, candidateId,
        sourceRevision, sourceKind: 'accepted_cold_search', publication: 'disabled',
        clientDraftFields: { candidateName: name, position: candidate.title, vacancyTitle,
          experience: candidate.experience.map(row => ({ role: row.position, company: row.company,
            period: row.end ? `${row.start} — ${row.end}` : `${row.start} — настоящее время` })),
          education: resumeResult.body.resume.education, courses: resumeResult.body.resume.courses,
          skills: resumeResult.body.resume.skills, languages: resumeResult.body.resume.languages,
          location: short(resumeResult.body.resume.location, 200) || null },
        internalAssessment: { atsScore: assessment.assessment.atsScore,
          atsTag: assessment.assessment.atsTag, reviewStatus: candidate.review.status,
          reviewRevision: candidate.review.revision, criteriaRevision: snapshot.criteriaRevision } } };
    } catch { return fail(503, 'report_source_unavailable'); }
  };
}
