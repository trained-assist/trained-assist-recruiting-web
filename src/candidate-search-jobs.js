import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(new URL('../data/cold-search-results.json', import.meta.url), 'utf8'));

export async function syntheticColdSearchProvider({ cursor }) {
  const page = fixture.pages.find(item => item.cursor === (cursor ?? null));
  if (!page) return { kind: 'error', code: 'provider_invalid_response', retryable: false };
  return { kind: 'page', sourceRevision: fixture.providerRevision, items: page.items, nextCursor: page.nextCursor, complete: page.complete };
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function canonicalRequest({ vacancyId, criteriaRevision, criteria }) {
  return { vacancyId, criteriaRevision, criteria: { keywords: [...criteria.keywords], regions: [...criteria.regions] } };
}

function publicJob(job) {
  return {
    domainApiVersion: 'v1', jobId: job.jobId, vacancyId: job.vacancyId,
    criteriaRevision: job.criteriaRevision, sourceRevision: job.sourceRevision ?? 'pending',
    status: job.status, resultCount: job.items.length,
    canResume: job.status === 'partial' && (job.providerError === null || job.providerError.retryable === true),
    ranking: 'provider_order_unranked', providerError: job.providerError
  };
}

function normalizeProviderError(code, retryable = false) {
  const allowed = ['provider_forbidden', 'provider_unavailable', 'provider_invalid_response'];
  const normalizedCode = allowed.includes(code) ? code : 'provider_unavailable';
  return { code: normalizedCode, retryable: normalizedCode === 'provider_forbidden' ? false : Boolean(retryable) };
}

export function createCandidateSearchJobs({ provider = syntheticColdSearchProvider, maxJobs = 100, maxResultsPerJob = 200 } = {}) {
  const jobs = new Map();
  const idempotency = new Map();

  async function runProvider(job) {
    job.status = 'running';
    job.providerError = null;
    let page;
    try { page = await provider({ vacancyId: job.vacancyId, criteria: job.criteria, cursor: job.providerCursor }); }
    catch (error) {
      const forbidden = error?.status === 403;
      job.providerError = normalizeProviderError(forbidden ? 'provider_forbidden' : 'provider_unavailable', !forbidden);
      job.status = job.items.length ? 'partial' : 'failed';
      return publicJob(job);
    }
    if (!page || page.kind === 'error') {
      job.providerError = normalizeProviderError(page?.code, page?.retryable);
      job.status = job.items.length ? 'partial' : 'failed';
      return publicJob(job);
    }
    if (page.kind !== 'page' || !/^cold-search-provider-demo-r[0-9]+$/.test(page.sourceRevision ?? '') || !Array.isArray(page.items) || page.items.length > 50 ||
        !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length <= 512) || typeof page.complete !== 'boolean' ||
        (page.complete && page.nextCursor !== null) || (!page.complete && page.nextCursor === null) ||
        (!page.complete && page.nextCursor === job.providerCursor) ||
        (job.sourceRevision !== null && job.sourceRevision !== page.sourceRevision)) {
      job.providerError = normalizeProviderError('provider_invalid_response');
      job.status = job.items.length ? 'partial' : 'failed';
      return publicJob(job);
    }
    const validItems = page.items.every(item => item && Object.keys(item).sort().join(',') === 'candidateRef,evidenceSummary,region,title,vacancyId' && item.vacancyId === job.vacancyId &&
      /^candidate_search_demo_[0-9]{3}$/.test(item.candidateRef) && typeof item.title === 'string' &&
      item.title.length > 0 && item.title.length <= 100 && typeof item.region === 'string' && item.region.length > 0 && item.region.length <= 100 &&
      typeof item.evidenceSummary === 'string' && item.evidenceSummary.length > 0 && item.evidenceSummary.length <= 500);
    if (!validItems) {
      job.providerError = normalizeProviderError('provider_invalid_response');
      job.status = job.items.length ? 'partial' : 'failed';
      return publicJob(job);
    }
    const newItems = page.items.filter(item => !job.items.some(existing => existing.candidateRef === item.candidateRef));
    if (job.items.length + newItems.length > maxResultsPerJob) {
      job.providerError = normalizeProviderError('provider_invalid_response');
      job.status = job.items.length ? 'partial' : 'failed';
      return publicJob(job);
    }
    job.sourceRevision ??= page.sourceRevision;
    const seen = new Set(job.items.map(item => item.candidateRef));
    for (const item of page.items) if (!seen.has(item.candidateRef)) { job.items.push({ ...item }); seen.add(item.candidateRef); }
    job.providerCursor = page.nextCursor;
    job.status = page.complete ? 'completed' : 'partial';
    return publicJob(job);
  }

  return {
    async start(profileId, key, request) {
      const input = canonicalRequest(request);
      const requestHash = digest(JSON.stringify(input));
      const scopeKey = JSON.stringify([profileId, key]);
      const existingId = idempotency.get(scopeKey);
      if (existingId) {
        const existing = jobs.get(existingId);
        if (!existing || existing.profileId !== profileId || existing.idempotencyKey !== key || existing.requestHash !== requestHash) return { conflict: true };
        return { conflict: false, created: false, job: publicJob(existing) };
      }
      if (jobs.size >= maxJobs) return { capacityExceeded: true };
      const jobId = `search_demo_${digest(scopeKey).slice(0, 12)}`;
      const collision = jobs.get(jobId);
      if (collision && (collision.profileId !== profileId || collision.idempotencyKey !== key)) return { conflict: true };
      const job = { jobId, profileId, idempotencyKey: key, requestHash, vacancyId: input.vacancyId, criteriaRevision: input.criteriaRevision, criteria: input.criteria, sourceRevision: null, status: 'running', items: [], providerCursor: null, providerError: null };
      jobs.set(jobId, job);
      idempotency.set(scopeKey, jobId);
      return { conflict: false, created: true, job: await runProvider(job) };
    },
    get(profileId, jobId) {
      const job = jobs.get(jobId);
      return job?.profileId === profileId ? publicJob(job) : null;
    },
    async resume(profileId, jobId) {
      const job = jobs.get(jobId);
      if (!job || job.profileId !== profileId) return null;
      const state = publicJob(job);
      if (!state.canResume) return { conflict: true, job: state };
      return { conflict: false, job: await runProvider(job) };
    },
    results(profileId, jobId, { limit, cursor }) {
      const job = jobs.get(jobId);
      if (!job || job.profileId !== profileId) return null;
      const resultRevision = digest(`${job.jobId}|${job.sourceRevision ?? 'none'}|${job.items.map(item => item.candidateRef).join(',')}`).slice(0, 16);
      let offset = 0;
      if (cursor !== null) {
        let parsed;
        try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { return { kind: 'invalid_cursor' }; }
        if (parsed.jobId !== job.jobId || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) return { kind: 'invalid_cursor' };
        if (parsed.resultRevision !== resultRevision) return { kind: 'stale_cursor', currentRevision: resultRevision };
        offset = parsed.offset;
      }
      if (offset > job.items.length) return { kind: 'invalid_cursor' };
      const items = job.items.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      const nextCursor = nextOffset < job.items.length ? Buffer.from(JSON.stringify({ jobId, offset: nextOffset, resultRevision })).toString('base64url') : null;
      return { domainApiVersion: 'v1', jobId, sourceRevision: job.sourceRevision ?? 'pending', resultRevision, freshness: 'current', items, nextCursor };
    }
  };
}
