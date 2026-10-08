import { randomUUID } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalRequest, candidateSearchResultPage, digest, publicJob, syntheticColdSearchProvider } from './candidate-search-jobs.js';

const UNKNOWN = { code: 'search_outcome_unknown', retryable: false };
const decode = row => row ? JSON.parse(row.payload) : null;

// Durable implementation of the candidate-search job API. A page is marked
// dispatching in SQLite before the provider is called. If its result cannot be
// committed, the job is quarantined instead of replaying that provider call.
export class SqliteCandidateSearchJobs {
  constructor({ filename, provider = syntheticColdSearchProvider, maxJobs = 100, maxResultsPerJob = 200, clock = () => new Date(), dispatchLeaseMs = 5 * 60_000 }) {
    if (typeof filename !== 'string' || !filename || filename === ':memory:') throw new TypeError('a durable SQLite filename is required');
    if (statSync(dirname(filename)).mode & 0o077) throw new Error('SQLite search directory must be owner-only (0700)');
    if (typeof provider !== 'function' || !Number.isSafeInteger(dispatchLeaseMs) || dispatchLeaseMs <= 0) throw new TypeError('valid provider and dispatch lease are required');
    this.provider = provider;
    this.maxJobs = maxJobs;
    this.maxResultsPerJob = maxResultsPerJob;
    this.clock = clock;
    this.dispatchLeaseMs = dispatchLeaseMs;
    this.db = new Database(filename, { timeout: 5000 });
    chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS candidate_search_jobs (
      job_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, status TEXT NOT NULL, dispatch_owner TEXT,
      dispatch_until TEXT, payload TEXT NOT NULL,
      UNIQUE(profile_id, idempotency_key)
    );`);
    this.byKey = this.db.prepare('SELECT payload FROM candidate_search_jobs WHERE profile_id = ? AND idempotency_key = ?');
    this.byId = this.db.prepare('SELECT payload FROM candidate_search_jobs WHERE job_id = ?');
    this.insert = this.db.prepare(`INSERT INTO candidate_search_jobs
      (job_id, profile_id, idempotency_key, request_hash, status, dispatch_owner, dispatch_until, payload)
      VALUES (@jobId, @profileId, @idempotencyKey, @requestHash, @status, @dispatchOwner, @dispatchUntil, @payload)`);
    this.update = this.db.prepare(`UPDATE candidate_search_jobs SET status=@status,
      dispatch_owner=@dispatchOwner, dispatch_until=@dispatchUntil, payload=@payload WHERE job_id=@jobId`);
  }

  close() { this.db.close(); }
  now() { return this.clock().toISOString(); }
  getRaw(id) { return decode(this.byId.get(id)); }
  persist(job) {
    this.update.run({ jobId: job.jobId, status: job.status, dispatchOwner: job.dispatchOwner,
      dispatchUntil: job.dispatchUntil, payload: JSON.stringify(job) });
  }
  expire(job) {
    if (job.status !== 'dispatching' || job.dispatchUntil > this.now()) return job;
    job.status = 'outcome_unknown';
    job.providerError = UNKNOWN;
    job.dispatchOwner = null;
    job.dispatchUntil = null;
    this.persist(job);
    return job;
  }

  quarantineExpiredDispatches() {
    return this.db.transaction(() => {
      const now = this.now();
      const rows = this.db.prepare("SELECT payload FROM candidate_search_jobs WHERE status = 'dispatching' AND dispatch_until <= ?").all(now).map(decode);
      for (const job of rows) this.expire(job);
      return rows.length;
    }).immediate();
  }

  countExpiredDispatches() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM candidate_search_jobs WHERE status = 'dispatching' AND dispatch_until <= ?").get(this.now()).count;
  }

  async start(profileId, key, request) {
    const input = canonicalRequest(request);
    const requestHash = digest(JSON.stringify(input));
    const scopeKey = JSON.stringify([profileId, key]);
    const claimed = this.db.transaction(() => {
      const existing = decode(this.byKey.get(profileId, key));
      if (existing) {
        this.expire(existing);
        if (existing.requestHash !== requestHash) return { conflict: true };
        return { conflict: false, created: false, job: existing };
      }
      if (this.db.prepare('SELECT COUNT(*) AS count FROM candidate_search_jobs').get().count >= this.maxJobs) return { capacityExceeded: true };
      const jobId = `search_demo_${digest(scopeKey).slice(0, 12)}`;
      if (this.byId.get(jobId)) return { conflict: true };
      const job = { jobId, profileId, idempotencyKey: key, requestHash,
        vacancyId: input.vacancyId, criteriaRevision: input.criteriaRevision, criteria: input.criteria,
        sourceRevision: null, status: 'dispatching', items: [], providerCursor: null, providerError: null,
        dispatchOwner: randomUUID(), dispatchUntil: new Date(Date.parse(this.now()) + this.dispatchLeaseMs).toISOString() };
      this.insert.run({ jobId, profileId, idempotencyKey: key, requestHash, status: job.status,
        dispatchOwner: job.dispatchOwner, dispatchUntil: job.dispatchUntil, payload: JSON.stringify(job) });
      return { conflict: false, created: true, job };
    }).immediate();
    if (claimed.conflict || claimed.capacityExceeded) return claimed;
    if (!claimed.created) return { ...claimed, job: publicJob(claimed.job) };
    return { conflict: false, created: true, job: await this.runPage(claimed.job) };
  }

  get(profileId, jobId) {
    return this.db.transaction(() => {
      const job = this.getRaw(jobId);
      return job?.profileId === profileId ? publicJob(this.expire(job)) : null;
    }).immediate();
  }

  async resume(profileId, jobId) {
    const claimed = this.db.transaction(() => {
      const job = this.getRaw(jobId);
      if (!job || job.profileId !== profileId) return null;
      this.expire(job);
      if (job.status !== 'partial' || job.providerError !== null) return { conflict: true, job: publicJob(job) };
      job.status = 'dispatching';
      job.dispatchOwner = randomUUID();
      job.dispatchUntil = new Date(Date.parse(this.now()) + this.dispatchLeaseMs).toISOString();
      this.persist(job);
      return { conflict: false, job };
    }).immediate();
    if (!claimed || claimed.conflict) return claimed;
    return { conflict: false, job: await this.runPage(claimed.job) };
  }

  results(profileId, jobId, page) {
    return this.db.transaction(() => {
      const job = this.getRaw(jobId);
      return job?.profileId === profileId ? candidateSearchResultPage(this.expire(job), page) : null;
    }).immediate();
  }

  async runPage(claimed) {
    let page;
    try {
      page = await this.provider({ vacancyId: claimed.vacancyId, criteria: claimed.criteria,
        cursor: claimed.providerCursor, operationId: `${claimed.jobId}:${digest(String(claimed.providerCursor)).slice(0, 12)}` });
    } catch { page = null; }
    return this.db.transaction(() => {
      const job = this.getRaw(claimed.jobId);
      if (!job || job.status !== 'dispatching' || job.dispatchOwner !== claimed.dispatchOwner || job.dispatchUntil <= this.now()) {
        if (job) this.expire(job);
        return job ? publicJob(job) : null;
      }
      const validPage = page?.kind === 'page' && /^cold-search-provider-demo-r[0-9]+$/.test(page.sourceRevision ?? '') &&
        Array.isArray(page.items) && page.items.length <= 50 &&
        (page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length <= 512) &&
        typeof page.complete === 'boolean' && (page.complete === (page.nextCursor === null)) &&
        (page.complete || page.nextCursor !== job.providerCursor) &&
        (job.sourceRevision === null || job.sourceRevision === page.sourceRevision) &&
        page.items.every(item => item && Object.keys(item).sort().join(',') === 'candidateRef,evidenceSummary,region,title,vacancyId' &&
          item.vacancyId === job.vacancyId && /^candidate_search_demo_[0-9]{3}$/.test(item.candidateRef) &&
          typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 100 &&
          typeof item.region === 'string' && item.region.length > 0 && item.region.length <= 100 &&
          typeof item.evidenceSummary === 'string' && item.evidenceSummary.length > 0 && item.evidenceSummary.length <= 500);
      const seen = new Set(job.items.map(item => item.candidateRef));
      const newItems = [];
      if (validPage) for (const item of page.items) {
        if (!seen.has(item.candidateRef)) { newItems.push(item); seen.add(item.candidateRef); }
      }
      if (!validPage || job.items.length + newItems.length > this.maxResultsPerJob) {
        job.status = 'outcome_unknown';
        job.providerError = UNKNOWN;
      } else {
        job.sourceRevision ??= page.sourceRevision;
        job.items.push(...newItems);
        job.providerCursor = page.nextCursor;
        job.status = page.complete ? 'completed' : 'partial';
        if (page.complete) job.completedAt = this.now();
        job.providerError = null;
      }
      job.dispatchOwner = null;
      job.dispatchUntil = null;
      this.persist(job);
      return publicJob(job);
    }).immediate();
  }
}
