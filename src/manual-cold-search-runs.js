import { randomUUID, createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);

function publicRun(run) {
  return {
    domainApiVersion: 'v1',
    runId: run.runId,
    vacancyId: run.vacancyId,
    ...(run.search.jobId ? { resultJobId: run.search.jobId } : {}),
    status: run.status,
    search: {
      status: run.search.status,
      phase: run.search.phase,
      pagesCompleted: run.search.pagesCompleted,
      totalPages: run.search.totalPages,
      resultCount: run.search.resultCount,
      sourceRevision: run.search.sourceRevision,
      ...(run.search.error ? { error: run.search.error } : {})
    },
    atsRefresh: { ...run.atsRefresh },
    automaticRetryAllowed: false,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {})
  };
}

export function createManualColdSearchRuns({ searchJobs, clock = () => new Date(), maxRuns = 100 } = {}) {
  if (!searchJobs || typeof searchJobs.start !== 'function' || typeof searchJobs.resume !== 'function') {
    throw new TypeError('candidate search job port is required');
  }
  const runs = new Map();
  const byIdempotency = new Map();

  function update(run, patch) {
    Object.assign(run, patch, { updatedAt: clock().toISOString() });
  }

  async function execute(run, request) {
    try {
      const started = await searchJobs.start(run.profileId, `manual-run:${run.runId}`, request);
      if (started.conflict || started.capacityExceeded) {
        const code = started.capacityExceeded ? 'search_job_capacity_reached' : 'idempotency_conflict';
        run.search = { ...run.search, status: 'failed', phase: 'dispatch', error: { code } };
        update(run, { status: 'failed', finishedAt: clock().toISOString() });
        return;
      }

      let job = started.job;
      run.search.jobId = job.jobId;
      let pagesCompleted = job.sourceRevision === 'pending' ? 0 : 1;
      for (let page = 0; page < 4; page++) {
        run.search = {
          ...run.search,
          status: job.status,
          phase: job.status === 'running' ? 'search' : job.status,
          pagesCompleted,
          resultCount: job.resultCount,
          sourceRevision: job.sourceRevision === 'pending' ? null : job.sourceRevision,
          ...(job.providerError ? { error: { code: job.providerError.code } } : { error: null })
        };
        update(run, {});

        if (job.status === 'completed') {
          run.search = { ...run.search, status: 'completed', phase: 'completed', error: null };
          run.atsRefresh = { status: 'pending', completed: 0, total: job.resultCount };
          update(run, { status: 'completed', finishedAt: clock().toISOString() });
          return;
        }
        if (job.status === 'outcome_unknown' || job.providerError?.code === 'search_outcome_unknown') {
          run.search = { ...run.search, status: 'outcome_unknown', phase: 'outcome_unknown', error: { code: 'search_outcome_unknown' } };
          update(run, { status: 'outcome_unknown', finishedAt: clock().toISOString() });
          return;
        }
        // A provider error needs an explicit new user action. Only clean partial pages
        // are advanced automatically as part of this bounded synthetic run.
        if (job.status !== 'partial' || !job.canResume || job.providerError) {
          run.search = { ...run.search, status: job.status === 'partial' ? 'partial' : 'failed', phase: job.status, error: job.providerError ? { code: job.providerError.code } : null };
          update(run, { status: run.search.status, finishedAt: clock().toISOString() });
          return;
        }
        const resumed = await searchJobs.resume(run.profileId, job.jobId);
        if (resumed.conflict || !resumed.job) {
          run.search = { ...run.search, status: 'outcome_unknown', phase: 'outcome_unknown', error: { code: 'search_outcome_unknown' } };
          update(run, { status: 'outcome_unknown', finishedAt: clock().toISOString() });
          return;
        }
        job = resumed.job;
        if (!job.providerError && ['partial', 'completed'].includes(job.status)) pagesCompleted++;
      }
      run.search = { ...run.search, status: 'partial', phase: 'page_limit', error: { code: 'search_page_limit_reached' } };
      update(run, { status: 'partial', finishedAt: clock().toISOString() });
    } catch {
      run.search = { ...run.search, status: 'outcome_unknown', phase: 'outcome_unknown', error: { code: 'search_outcome_unknown' } };
      update(run, { status: 'outcome_unknown', finishedAt: clock().toISOString() });
    }
  }

  return {
    start(profileId, idempotencyKey, request) {
      const fingerprint = hash(JSON.stringify(request));
      const key = JSON.stringify([profileId, idempotencyKey]);
      const oldId = byIdempotency.get(key);
      if (oldId) {
        const old = runs.get(oldId);
        if (!old || old.requestFingerprint !== fingerprint) return { kind: 'conflict' };
        return { kind: 'replay', run: publicRun(old) };
      }
      if (runs.size >= maxRuns) return { kind: 'capacity' };
      const now = clock().toISOString();
      const run = {
        runId: randomUUID(), profileId, idempotencyKey, requestFingerprint: fingerprint,
        vacancyId: request.vacancyId, status: 'queued', startedAt: now, updatedAt: now,
        finishedAt: null,
        search: { status: 'queued', phase: 'queued', pagesCompleted: 0, totalPages: null, resultCount: 0, sourceRevision: null, error: null },
        atsRefresh: { status: 'not_started', completed: 0, total: null }
      };
      runs.set(run.runId, run);
      byIdempotency.set(key, run.runId);
      update(run, { status: 'running' });
      run.search = { ...run.search, status: 'running', phase: 'search' };
      void execute(run, copy(request));
      return { kind: 'created', run: publicRun(run) };
    },
    get(profileId, runId) {
      const run = runs.get(runId);
      if (!run) return { kind: 'unknown' };
      if (run.profileId !== profileId) return { kind: 'not_found' };
      return { kind: 'found', run: publicRun(run) };
    }
  };
}
