import { randomUUID } from 'node:crypto';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sourceHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reportRef = () => `report_${randomUUID().replaceAll('-', '')}`;
const revisionOf = value => `report-r${value}`;
const SOURCE_KINDS = new Set(['accepted_cold_search', 'accepted_hh_response']);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function publicReport(record) {
  return {
    domainApiVersion: 'v1', reportRef: record.reportRef, candidateId: record.candidateId,
    sourceKind: record.sourceKind,
    vacancyId: record.vacancyId, sourceRevision: record.sourceRevision,
    reportRevision: revisionOf(record.revision), status: record.status,
    reviewState: record.reviewState, clientFields: structuredClone(record.clientFields),
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

function renderClientDraft(record) {
  const fields = record.clientFields;
  const experience = fields.experience.map(item => `<li><strong>${escapeHtml(item.role)}</strong> — ${escapeHtml(item.company)} (${escapeHtml(item.period)})</li>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><meta name="report-source-revision" content="${record.sourceRevision}"><title>${escapeHtml(fields.candidateName)} — ${escapeHtml(fields.vacancyTitle)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#17212b}aside{padding:.75rem;background:#fff3cd;margin-bottom:1.5rem}</style></head><body><main><aside>ЧЕРНОВИК · ТРЕБУЕТ ПРОВЕРКИ · НЕ ОТПРАВЛЕН</aside><h1>${escapeHtml(fields.candidateName)}</h1><p>${escapeHtml(fields.position)} · ${escapeHtml(fields.vacancyTitle)}</p><section><h2>Опыт</h2><ul>${experience}</ul></section></main></body></html>`;
}

function validClientFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'candidateName,experience,position,vacancyTitle' ||
      !['candidateName', 'position', 'vacancyTitle'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 300) ||
      !Array.isArray(value.experience) || value.experience.length > 5) return false;
  return value.experience.every(row => row && typeof row === 'object' && !Array.isArray(row) &&
    Object.keys(row).sort().join(',') === 'company,period,role' &&
    ['company', 'period', 'role'].every(key => typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 500));
}

// Drafts contain only the allowlisted client projection. The internal ATS
// assessment returned alongside the source is never copied to the store/API.
export function createAcceptedReportDrafts({ sourceRead, store, clock = () => new Date() } = {}) {
  if (typeof sourceRead !== 'function' || !store ||
      !['create', 'get', 'update'].every(method => typeof store[method] === 'function') ||
      typeof clock !== 'function') throw new TypeError('accepted_report_draft_ports_required');

  async function currentSource(context, record) {
    let result;
    try { result = await sourceRead(context, { vacancyId: record.vacancyId, candidateId: record.candidateId,
      sourceKind: record.sourceKind }); }
    catch { return { kind: 'source_unavailable' }; }
    if (result?.status === 409) return { kind: 'stale_source' };
    if (result?.status === 404) return { kind: 'source_not_found' };
    if (result?.status !== 200 || result.body?.profileId !== context.profileId ||
        result.body?.vacancyId !== record.vacancyId || result.body?.candidateId !== record.candidateId ||
        result.body?.sourceKind !== record.sourceKind || !SOURCE_KINDS.has(record.sourceKind) ||
        result.body?.publication !== 'disabled' ||
        !sourceHash(result.body.sourceRevision) || !validClientFields(result.body.clientDraftFields))
      return { kind: 'source_unavailable' };
    if (result.body.sourceRevision !== record.sourceRevision) return { kind: 'stale_source' };
    return { kind: 'current', source: result.body };
  }

  return {
    async create(context, key, request) {
      const sourceKind = request?.sourceKind ?? 'accepted_cold_search';
      if (!safeId(context?.profileId) || !safeId(request?.candidateId) || !safeId(request?.vacancyId) ||
          !SOURCE_KINDS.has(sourceKind) ||
          !sourceHash(request?.expectedSourceRevision)) return { kind: 'invalid_request' };
      let result;
      try { result = await sourceRead(context, { vacancyId: request.vacancyId,
        candidateId: request.candidateId, sourceKind }); }
      catch { return { kind: 'source_unavailable' }; }
      if (result?.status === 409) return { kind: 'stale_source' };
      if (result?.status === 404) return { kind: 'source_not_found' };
      const source = result?.body;
      if (result?.status !== 200 || source?.profileId !== context.profileId ||
          source?.candidateId !== request.candidateId || source?.vacancyId !== request.vacancyId ||
          source?.sourceKind !== sourceKind || source?.publication !== 'disabled' ||
          !sourceHash(source?.sourceRevision) || !validClientFields(source?.clientDraftFields))
        return { kind: result?.status === 404 ? 'source_not_found' : 'source_unavailable' };
      if (source.sourceRevision !== request.expectedSourceRevision) return { kind: 'stale_source', currentSourceRevision: source.sourceRevision };
      const now = clock().toISOString();
      const record = {
        reportRef: reportRef(), profileId: context.profileId, sourceKind,
        candidateId: request.candidateId, vacancyId: request.vacancyId,
        sourceRevision: source.sourceRevision, revision: 1, status: 'draft', reviewState: 'unreviewed',
        clientFields: structuredClone(source.clientDraftFields), createdAt: now, updatedAt: now,
        audit: [{ action: 'draft_created', revision: 1, actorProfileId: context.profileId, at: now, sourceRevision: source.sourceRevision }],
      };
      const created = await store.create({ profileId: context.profileId, idempotencyKey: key,
        requestFingerprint: JSON.stringify([sourceKind, request.candidateId, request.vacancyId, request.expectedSourceRevision]), record });
      if (created.kind === 'created' || created.kind === 'existing')
        return { kind: created.kind, report: publicReport(created.record) };
      return created;
    },
    async get(context, ref) {
      if (!safeId(context?.profileId) || typeof ref !== 'string' || !/^report_[a-f0-9]{32}$/.test(ref)) return { kind: 'not_found' };
      const record = await store.get(context.profileId, ref);
      if (!record) return { kind: 'not_found' };
      const current = await currentSource(context, record);
      if (current.kind !== 'current') return { kind: current.kind, report: publicReport(record) };
      return { kind: 'found', report: publicReport(record) };
    },
    async preview(context, ref) {
      const result = await this.get(context, ref);
      if (result.kind !== 'found') return result;
      const record = await store.get(context.profileId, ref);
      return { kind: 'preview', body: { ...publicReport(record), mode: 'preview', audience: 'client',
        previewOnly: true, publication: 'not_shared', html: renderClientDraft(record) } };
    },
    async review(context, ref, expectedReportRevision, decision) {
      if (!safeId(context?.profileId) || !/^report_[a-f0-9]{32}$/.test(ref ?? '') ||
          !/^report-r[1-9][0-9]*$/.test(expectedReportRevision ?? '') ||
          !['approved', 'changes_requested'].includes(decision)) return { kind: 'invalid_request' };
      const record = await store.get(context.profileId, ref);
      if (!record) return { kind: 'not_found' };
      const current = await currentSource(context, record);
      if (current.kind !== 'current') return { kind: current.kind, report: publicReport(record) };
      if (record.status !== 'draft') return { kind: 'not_reviewable', report: publicReport(record) };
      if (expectedReportRevision !== revisionOf(record.revision)) return { kind: 'stale_report', report: publicReport(record) };
      const now = clock().toISOString();
      const updated = { ...record, revision: record.revision + 1, reviewState: decision, updatedAt: now,
        audit: [...record.audit, { action: decision, revision: record.revision + 1,
          actorProfileId: context.profileId, at: now, sourceRevision: record.sourceRevision }] };
      const result = await store.update(context.profileId, ref, record.revision, updated);
      return result.kind === 'updated' ? { kind: 'reviewed', report: publicReport(result.record) } : result;
    },
  };
}

export function createMemoryAcceptedReportDraftStore() {
  const byRef = new Map(); const byKey = new Map();
  return {
    create({ profileId, idempotencyKey, requestFingerprint, record }) {
      const key = JSON.stringify([profileId, idempotencyKey]);
      const existing = byKey.get(key);
      if (existing) {
        const prior = byRef.get(existing);
        return prior?.requestFingerprint === requestFingerprint
          ? { kind: 'existing', record: structuredClone(prior.record) } : { kind: 'idempotency_conflict' };
      }
      byRef.set(record.reportRef, { requestFingerprint, record: structuredClone(record) });
      byKey.set(key, record.reportRef);
      return { kind: 'created', record: structuredClone(record) };
    },
    get(profileId, ref) {
      const record = byRef.get(ref)?.record;
      return record?.profileId === profileId ? structuredClone(record) : null;
    },
    update(profileId, ref, expectedRevision, next) {
      const current = byRef.get(ref)?.record;
      if (!current || current.profileId !== profileId) return { kind: 'not_found' };
      if (current.revision !== expectedRevision) return { kind: 'stale_report', record: publicReport(current) };
      byRef.get(ref).record = structuredClone(next);
      return { kind: 'updated', record: structuredClone(next) };
    },
  };
}
