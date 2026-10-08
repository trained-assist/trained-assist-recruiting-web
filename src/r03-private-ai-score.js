const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));

// Explicit recruiter action for the latest accepted candidate. The five-minute
// scorer and this route share the assessment DTO and SQLite first-wins fence.
export function createR03PrivateAiScore({ feed, candidateState, loadBasePlan, evaluate,
  isVacancyOwned, clock = () => new Date(), timeoutMs = 50_000 } = {}) {
  if (typeof feed?.read !== 'function' || typeof candidateState?.assessmentForLatest !== 'function' ||
      typeof candidateState?.recordAssessment !== 'function' || typeof loadBasePlan !== 'function' ||
      typeof evaluate !== 'function' || typeof isVacancyOwned !== 'function' || typeof clock !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('private_ai_score_ports_required');
  const inFlight = new Map();
  const response = (assessment, cached) => ({ status: 200, body: { ok: true, cached,
    atsScore: assessment.atsScore, atsTag: assessment.atsTag, knockout: assessment.knockout } });
  return async (context, command) => {
    if (!exact(command, ['vacancy_id', 'candidate_id', 'expected_job_id']) ||
        ![command.vacancy_id, command.candidate_id, command.expected_job_id].every(safeId))
      return { status: 400, body: { error: 'invalid_ai_score_request' } };
    const { profileId } = context ?? {};
    const vacancyId = command.vacancy_id;
    if (!safeId(profileId) || !context.scopes?.includes('recruiting.candidateSearch') ||
        !isVacancyOwned(profileId, vacancyId)) return { status: 404, body: { error: 'vacancy_not_found' } };
    let item;
    try { item = feed.read(context, vacancyId).items.find(row => row.id === command.candidate_id); }
    catch { return { status: 503, body: { error: 'candidate_feed_unavailable' } }; }
    if (!item) return { status: 404, body: { error: 'candidate_not_found' } };
    if (item.jobId !== command.expected_job_id)
      return { status: 409, body: { error: 'candidate_result_changed' } };
    if (item.atsScore !== null && item.atsScore !== undefined)
      return response(item, true);
    const target = candidateState.assessmentForLatest({ profileId, vacancyId,
      jobId: item.jobId, candidateId: item.id, at: clock().toISOString() });
    if (target.kind === 'stale') return { status: 409, body: { error: 'candidate_not_in_latest_snapshot' } };
    if (target.kind === 'not_found') return { status: 404, body: { error: 'candidate_not_found' } };
    if (target.kind === 'retry_later') return { status: 429, body: { error: 'assessment_retry_later', retryAt: target.retryAt } };
    if (target.kind === 'scored') return response(target.assessment, true);
    const key = [profileId, vacancyId, item.jobId, item.id, target.inputRevision].join(':');
    if (inFlight.has(key)) return inFlight.get(key);
    const task = (async () => {
      const currentRevision = async () => {
        const plan = await loadBasePlan(profileId, vacancyId, { allowGeneration: false });
        return plan?.profileId === profileId && plan?.vacancyId === vacancyId ? plan.criteriaRevision : null;
      };
      let before;
      try { before = await currentRevision(); } catch { /* held below */ }
      if (!before || before !== target.snapshot.criteriaRevision)
        return { status: 409, body: { error: 'assessment_criteria_changed' } };
      let timer;
      let assessment;
      try {
        assessment = await Promise.race([
          evaluate({ profileId, vacancyId, candidate: target.candidate,
            criteriaRevision: before, inputRevision: target.inputRevision }),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('assessment_timeout')), timeoutMs); })
        ]);
      } catch {
        candidateState.recordAssessmentFailure?.({ profileId, vacancyId, jobId: item.jobId,
          candidateId: item.id, inputRevision: target.inputRevision, failedAt: clock().toISOString() });
        return { status: 503, body: { error: 'assessment_unavailable' } };
      } finally { clearTimeout(timer); }
      let after;
      try { after = await currentRevision(); } catch { /* held below */ }
      if (after !== before) return { status: 409, body: { error: 'assessment_criteria_changed' } };
      let written;
      try { written = candidateState.recordAssessment({ profileId, vacancyId, jobId: item.jobId,
        candidateId: item.id, inputRevision: target.inputRevision, assessment,
        assessedAt: clock().toISOString() }); }
      catch {
        candidateState.recordAssessmentFailure?.({ profileId, vacancyId, jobId: item.jobId,
          candidateId: item.id, inputRevision: target.inputRevision, failedAt: clock().toISOString() });
        return { status: 503, body: { error: 'assessment_unavailable' } };
      }
      if (written.kind === 'stale') return { status: 409, body: { error: 'candidate_result_changed' } };
      if (written.kind === 'already_scored') {
        const prior = candidateState.assessmentForLatest({ profileId, vacancyId,
          jobId: item.jobId, candidateId: item.id, at: clock().toISOString() });
        return prior.kind === 'scored' ? response(prior.assessment, true) :
          { status: 409, body: { error: 'candidate_result_changed' } };
      }
      return response(assessment, false);
    })();
    inFlight.set(key, task);
    try { return await task; } finally { inFlight.delete(key); }
  };
}
