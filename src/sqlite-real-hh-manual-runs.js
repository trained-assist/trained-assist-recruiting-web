import { createHash } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = row => row ? JSON.parse(row.payload) : null;

function publicRun(run) {
  return { domainApiVersion: 'v1', runId: run.runId, vacancyId: run.vacancyId,
    resultJobId: run.jobId, status: run.status,
    search: { status: run.status, phase: run.phase, pagesCompleted: run.pagesCompleted,
      totalPages: run.totalPages, resultCount: run.resultCount, sourceRevision: run.sourceRevision,
      ...(run.errorCode ? { error: { code: run.errorCode } } : {}) },
    atsRefresh: { status: run.status === 'completed' ? 'pending' : 'not_started',
      completed: 0, total: run.status === 'completed' ? run.resultCount : null },
    automaticRetryAllowed: false, startedAt: run.startedAt, updatedAt: run.updatedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) };
}

// The provider runs outside the SQLite transaction. A timed-out or crashed
// process leaves a durable unknown row and never automatically redispatches.
export class SqliteRealHhManualRuns {
  constructor({ filename, isVacancyOwned = () => false, loadSearchPlan, search, candidateState,
    clock = () => new Date(), leaseMs = 5 * 60_000 } = {}) {
    if (typeof filename !== 'string' || !filename || filename === ':memory:' || statSync(dirname(filename)).mode & 0o077)
      throw new TypeError('private durable filename required');
    if (typeof isVacancyOwned !== 'function' || typeof loadSearchPlan !== 'function' ||
        typeof search?.run !== 'function' || typeof candidateState?.resultPage !== 'function' ||
        typeof clock !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 1)
      throw new TypeError('manual HH run ports required');
    this.isVacancyOwned = isVacancyOwned;
    this.loadSearchPlan = loadSearchPlan;
    this.search = search;
    this.candidateState = candidateState;
    this.clock = clock;
    this.leaseMs = leaseMs;
    this.db = new Database(filename, { timeout: 5000 });
    chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS real_hh_manual_run (
      run_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
      lease_until TEXT, payload TEXT NOT NULL, UNIQUE(profile_id, idempotency_key)
    )`);
    this.byKey = this.db.prepare('SELECT payload FROM real_hh_manual_run WHERE profile_id=? AND idempotency_key=?');
    this.byId = this.db.prepare('SELECT profile_id, payload FROM real_hh_manual_run WHERE run_id=?');
    this.completedByVacancy = this.db.prepare(`SELECT payload FROM real_hh_manual_run
      WHERE profile_id=? AND vacancy_id=? AND status='completed' ORDER BY run_id LIMIT 1001`);
    this.insert = this.db.prepare(`INSERT INTO real_hh_manual_run(run_id,profile_id,vacancy_id,idempotency_key,request_hash,status,lease_until,payload)
      VALUES (@runId,@profileId,@vacancyId,@idempotencyKey,@requestHash,@status,@leaseUntil,@payload)`);
    this.update = this.db.prepare(`UPDATE real_hh_manual_run SET status=@status,lease_until=@leaseUntil,payload=@payload
      WHERE run_id=@runId AND status='running'`);
  }

  close() { this.db.close(); }

  scope(context, vacancyId) {
    return safeId(context?.profileId) && context.scopes?.includes('recruiting.candidateSearch') &&
      safeId(vacancyId) && this.isVacancyOwned(context.profileId, vacancyId);
  }

  recoverExpired() {
    const now = this.clock().toISOString();
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT payload FROM real_hh_manual_run WHERE status='running' AND lease_until <= ?").all(now).map(parse);
      for (const row of rows) {
        row.status = 'outcome_unknown'; row.phase = 'outcome_unknown'; row.errorCode = 'search_outcome_unknown';
        row.updatedAt = now; row.finishedAt = now; row.leaseUntil = null;
        this.update.run({ runId: row.runId, status: row.status, leaseUntil: null, payload: JSON.stringify(row) });
      }
      return rows.length;
    }).immediate();
  }

  async start(context, idempotencyKey, request) {
    if (!this.scope(context, request?.vacancyId) || !safeId(idempotencyKey) ||
        !request || Object.keys(request).some(key => !['vacancyId', 'criteriaRevision', 'queryRevision'].includes(key)) ||
        typeof request.criteriaRevision !== 'string' || !request.criteriaRevision ||
        typeof request.queryRevision !== 'string' || !request.queryRevision) return { kind: 'denied_or_invalid' };
    this.recoverExpired();
    const profileId = context.profileId;
    const requestHash = hash(request);
    const existing = parse(this.byKey.get(profileId, idempotencyKey));
    if (existing) return existing.requestHash === requestHash
      ? { kind: 'replay', run: publicRun(existing) } : { kind: 'conflict' };
    let plan;
    try { plan = await this.loadSearchPlan(profileId, request.vacancyId); } catch { plan = null; }
    if (!plan || plan.profileId !== profileId || plan.vacancyId !== request.vacancyId ||
        plan.criteriaRevision !== request.criteriaRevision || plan.queryCache?.revision !== request.queryRevision ||
        !Array.isArray(plan.queryCache.queries) || plan.queryCache.queries.length < 1 || plan.queryCache.queries.length > 15)
      return { kind: 'search_plan_unavailable' };
    const now = this.clock().toISOString();
    const runId = `manual_${hash([profileId, idempotencyKey]).slice(0, 32)}`;
    const jobId = `hh_manual_${hash(runId).slice(0, 32)}`;
    const row = { runId, jobId, profileId, vacancyId: request.vacancyId, idempotencyKey, requestHash,
      criteriaRevision: request.criteriaRevision, queryRevision: request.queryRevision,
      status: 'running', phase: 'search', pagesCompleted: 0, totalPages: plan.queryCache.queries.length,
      resultCount: 0, sourceRevision: null, resultRevision: null, errorCode: null, startedAt: now, updatedAt: now,
      finishedAt: null, leaseUntil: new Date(Date.parse(now) + this.leaseMs).toISOString() };
    const created = this.db.transaction(() => {
      const concurrent = parse(this.byKey.get(profileId, idempotencyKey));
      if (concurrent) return concurrent.requestHash === requestHash
        ? { kind: 'replay', run: publicRun(concurrent) } : { kind: 'conflict' };
      this.insert.run({ ...row, payload: JSON.stringify(row) });
      return { kind: 'created', run: publicRun(row) };
    }).immediate();
    if (created.kind === 'created') void this.execute(row, context);
    return created;
  }

  async execute(row, context) {
    let patch;
    try {
      const result = await this.search.run({ trustedContext: context, vacancyId: row.vacancyId,
        jobId: row.jobId, source: 'manual', expectedCriteriaRevision: row.criteriaRevision,
        expectedQueryRevision: row.queryRevision });
      const snapshot = result?.snapshot;
      if (result?.status !== 'completed' || snapshot?.profileId !== row.profileId ||
          snapshot?.vacancyId !== row.vacancyId || snapshot?.jobId !== row.jobId ||
          snapshot?.source !== 'manual' || snapshot?.criteriaRevision !== row.criteriaRevision ||
          !/^[a-f0-9]{24}$/.test(snapshot?.resultRevision ?? ''))
        throw new Error('invalid_manual_result');
      patch = { status: 'completed', phase: 'completed', pagesCompleted: row.totalPages,
        resultCount: snapshot.candidateCount, sourceRevision: snapshot.sourceRevision,
        resultRevision: snapshot.resultRevision, errorCode: null };
    } catch (error) {
      const rejected = error?.code === 'search_plan_unavailable' || error?.code === 'search_scope_denied';
      patch = { status: rejected ? 'rejected' : 'outcome_unknown', phase: rejected ? 'pre_dispatch' : 'outcome_unknown',
        errorCode: rejected ? 'search_plan_unavailable' : 'search_outcome_unknown' };
    }
    const now = this.clock().toISOString();
    const current = parse(this.byId.get(row.runId));
    if (!current || current.status !== 'running' || current.leaseUntil <= now) return;
    Object.assign(current, patch, { updatedAt: now, finishedAt: now, leaseUntil: null });
    this.update.run({ runId: row.runId, status: current.status, leaseUntil: null, payload: JSON.stringify(current) });
  }

  get(context, runId) {
    if (!safeId(context?.profileId) || !context.scopes?.includes('recruiting.candidateSearch') || !safeId(runId)) return { kind: 'denied' };
    this.recoverExpired();
    const selected = this.byId.get(runId);
    if (!selected) return { kind: 'unknown' };
    if (selected.profile_id !== context.profileId) return { kind: 'not_found' };
    return { kind: 'found', run: publicRun(parse(selected)) };
  }

  resultPage(context, runId, options = {}) {
    const selected = this.get(context, runId);
    if (selected.kind !== 'found' || selected.run.status !== 'completed') return selected;
    if (!this.scope(context, selected.run.vacancyId)) return { kind: 'denied' };
    return { kind: 'found', page: this.candidateState.resultPage({ profileId: context.profileId,
      vacancyId: selected.run.vacancyId, jobId: selected.run.resultJobId, ...options }) };
  }

  // Trusted feed adapter: request data cannot assert success. A receipt exists
  // only when the durable run and its exact committed snapshot still agree.
  listAcceptedManualReceipts(profileId, vacancyId) {
    if (!safeId(profileId) || !safeId(vacancyId) || !this.isVacancyOwned(profileId, vacancyId))
      throw new Error('manual_receipt_scope_denied');
    const rows = this.completedByVacancy.all(profileId, vacancyId).map(parse);
    if (rows.length > 1000) throw new Error('manual_receipt_capacity_exceeded');
    return rows.flatMap(row => {
      if (row.status !== 'completed' || row.profileId !== profileId || row.vacancyId !== vacancyId ||
          !safeId(row.jobId) || row.jobId !== `hh_manual_${hash(row.runId).slice(0, 32)}` ||
          !/^[a-f0-9]{24}$/.test(row.resultRevision ?? '')) return [];
      const snapshot = this.candidateState.resultPage({ profileId, vacancyId, jobId: row.jobId, limit: 1 })?.snapshot;
      if (!snapshot || snapshot.source !== 'manual' || snapshot.profileId !== profileId ||
          snapshot.vacancyId !== vacancyId || snapshot.jobId !== row.jobId ||
          snapshot.criteriaRevision !== row.criteriaRevision || snapshot.sourceRevision !== row.sourceRevision ||
          snapshot.resultRevision !== row.resultRevision || snapshot.candidateCount !== row.resultCount) return [];
      return [{ status: 'succeeded', profileId, vacancyId, jobId: row.jobId,
        sourceRevision: row.sourceRevision, resultRevision: row.resultRevision,
        resultCount: row.resultCount }];
    });
  }
}
