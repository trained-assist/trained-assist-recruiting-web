import { randomUUID } from 'node:crypto';
import { checkReportPolicy } from './report-policy.js';

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
    fieldProvenance: structuredClone(record.fieldProvenance ?? {}),
    policyRevision: `policy-r${record.policyRevision}`,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

function renderClientDraft(record, { approved = false } = {}) {
  const fields = record.clientFields;
  const experience = fields.experience.map(item => `<article class="job"><h3>${escapeHtml(item.role)} — ${escapeHtml(item.company)}</h3><p class="period">${escapeHtml(item.period)}</p>${item.details?.length ? `<ul>${item.details.map(detail => `<li>${escapeHtml(detail)}</li>`).join('')}</ul>` : ''}</article>`).join('');
  const listSection = (title, values) => values?.length ? `<section><h2>${title}</h2><ul>${values.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul></section>` : '';
  const location = fields.location ? `<p class="role">${escapeHtml(fields.location)}</p>` : '';
  const fit = (fields.fit ?? []).map(item => `<tr><td class="${item.status}">${escapeHtml({ yes: '✓', partial: '~', no: '✗' }[item.status])}</td><td>${escapeHtml(item.requirement)}</td><td>${escapeHtml(item.comment)}</td></tr>`).join('');
  const summary = fields.summary?.trim() ? `<section><h2>Кратко о кандидате</h2><p>${escapeHtml(fields.summary)}</p></section>` : '';
  const conclusion = fields.conclusion?.trim() ? `<section><h2>Вывод рекрутера</h2><div class="conclusion">${escapeHtml(fields.conclusion)}</div></section>` : '';
  const matrix = fit ? `<section><h2>Соответствие вакансии</h2><table><thead><tr><th>Статус</th><th>Требование</th><th>Комментарий</th></tr></thead><tbody>${fit}</tbody></table><p class="legend">✓ соответствует · ~ частично / с нюансом · ✗ не соответствует</p></section>` : '';
  const stateBanner = approved ? '' : '<aside>ЧЕРНОВИК · ТРЕБУЕТ ПРОВЕРКИ · НЕ ОТПРАВЛЕН</aside>';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><meta name="report-source-revision" content="${record.sourceRevision}"><title>${escapeHtml(fields.candidateName)} — ${escapeHtml(fields.vacancyTitle)}</title><style>*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1c2430;background:#fff}.page{max-width:820px;margin:0 auto;padding:28px 32px}header{border-bottom:2px solid #1f4e8c;padding-bottom:16px}h1{margin:0 0 2px;font-size:24px}h2{font-size:16px;color:#1f4e8c;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.04em}p{margin:0 0 8px}.role,.period,.legend{color:#5d6b7c}.job{margin-bottom:10px;break-inside:avoid}.job h3{font-size:15px;margin:0}.job ul{margin:4px 0 0 18px;padding:0}section ul{margin:4px 0 0 18px;padding:0}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border-bottom:1px solid #dfe4ea;padding:6px 8px;text-align:left;vertical-align:top}.yes{color:#1e7a46}.partial{color:#a86a00}.no{color:#b3261e}.legend{font-size:12px;margin-top:6px}.conclusion{background:#f6f8fb;border-left:4px solid #1f4e8c;padding:10px 14px;white-space:pre-wrap}aside{padding:.75rem;background:#fff3cd;margin-bottom:1.5rem}@page{size:A4;margin:0}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.page{max-width:none;padding:14mm 16mm}h2,tr{break-inside:avoid}h2{break-after:avoid}}</style></head><body><main class="page">${stateBanner}<header><h1>${escapeHtml(fields.candidateName)}</h1><p class="role">${escapeHtml(fields.position)} · ${escapeHtml(fields.vacancyTitle)}</p>${location}</header>${listSection('Образование', fields.education)}${listSection('Курсы', fields.courses)}${listSection('Навыки', fields.skills)}${listSection('Языки', fields.languages)}${summary}<section><h2>Опыт</h2>${experience}</section>${matrix}${conclusion}</main></body></html>`;
}

function validClientFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['candidateName', 'experience', 'position', 'vacancyTitle', 'summary', 'fit', 'conclusion', 'education', 'courses', 'skills', 'languages', 'location'].includes(key)) ||
      !['candidateName', 'position', 'vacancyTitle'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 300) ||
      !Array.isArray(value.experience) || value.experience.length > 5) return false;
  if (!value.experience.every(row => row && typeof row === 'object' && !Array.isArray(row) &&
    ['company', 'period', 'role'].every(key => typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 500) &&
    Object.keys(row).every(key => ['company', 'period', 'role', 'details'].includes(key)) &&
    (row.details === undefined || Array.isArray(row.details) && row.details.length <= 10 && row.details.every(item => typeof item === 'string' && item.length <= 500)))) return false;
  return (value.summary === undefined || typeof value.summary === 'string' && value.summary.length <= 3000) &&
    (value.conclusion === undefined || typeof value.conclusion === 'string' && value.conclusion.length <= 1500) &&
    ['education', 'courses', 'skills', 'languages'].every((field, index) => value[field] === undefined || Array.isArray(value[field]) && value[field].length <= [10, 20, 30, 20][index] && value[field].every(item => typeof item === 'string' && item.trim() && item.length <= [300, 300, 100, 150][index])) &&
    (value.location === undefined || value.location === null || typeof value.location === 'string' && value.location.length <= 200) &&
    (value.fit === undefined || Array.isArray(value.fit) && value.fit.length <= 20 && value.fit.every(item => item && typeof item === 'object' &&
      Object.keys(item).every(key => ['requirement', 'status', 'comment'].includes(key)) &&
      ['requirement', 'status', 'comment'].every(key => key in item) && typeof item.requirement === 'string' && item.requirement.length <= 300 &&
      ['yes', 'partial', 'no'].includes(item.status) && typeof item.comment === 'string' && item.comment.length <= 1000));
}

function validClientEdits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0 ||
      Object.keys(value).some(key => !['position', 'vacancyTitle', 'experience', 'summary', 'fit', 'conclusion', 'education', 'courses', 'skills', 'languages', 'location'].includes(key))) return false;
  if ('position' in value && (typeof value.position !== 'string' || !value.position.trim() || value.position.length > 300)) return false;
  if ('vacancyTitle' in value && (typeof value.vacancyTitle !== 'string' || !value.vacancyTitle.trim() || value.vacancyTitle.length > 300)) return false;
  if ('experience' in value && (!Array.isArray(value.experience) || value.experience.length > 5 ||
      !value.experience.every(row => row && typeof row === 'object' && !Array.isArray(row) &&
        Object.keys(row).every(key => ['company', 'period', 'role', 'details'].includes(key)) &&
        ['company', 'period', 'role'].every(key => typeof row[key] === 'string' && row[key].trim() && row[key].length <= 500) &&
        (row.details === undefined || Array.isArray(row.details) && row.details.length <= 10 && row.details.every(item => typeof item === 'string' && item.length <= 500))))) return false;
  if ('summary' in value && (typeof value.summary !== 'string' || value.summary.length > 3000)) return false;
  if ('conclusion' in value && (typeof value.conclusion !== 'string' || value.conclusion.length > 1500)) return false;
  for (const [field, maxItems, maxLength] of [['education', 10, 300], ['courses', 20, 300], ['skills', 30, 100], ['languages', 20, 150]])
    if (field in value && (!Array.isArray(value[field]) || value[field].length > maxItems || !value[field].every(item => typeof item === 'string' && item.trim() && item.length <= maxLength))) return false;
  if ('location' in value && value.location !== null && (typeof value.location !== 'string' || value.location.length > 200)) return false;
  if ('fit' in value && (!Array.isArray(value.fit) || value.fit.length > 20 || !value.fit.every(item => item && typeof item === 'object' &&
      Object.keys(item).every(key => ['requirement', 'status', 'comment'].includes(key)) &&
      ['requirement', 'status', 'comment'].every(key => key in item) && typeof item.requirement === 'string' && item.requirement.length <= 300 &&
      ['yes', 'partial', 'no'].includes(item.status) && typeof item.comment === 'string' && item.comment.length <= 1000))) return false;
  return true;
}

// Drafts contain only the allowlisted client projection. The internal ATS
// assessment returned alongside the source is never copied to the store/API.
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validGeneratedFields(value, source) {
  if (!isPlainObject(value) || Object.keys(value).length === 0 ||
      Object.keys(value).some(key => !['summary', 'fit', 'conclusion', 'experienceDetails'].includes(key))) return false;
  if ('summary' in value && (typeof value.summary !== 'string' || value.summary.length > 3000)) return false;
  if ('conclusion' in value && (typeof value.conclusion !== 'string' || value.conclusion.length > 1500)) return false;
  if ('fit' in value && (!Array.isArray(value.fit) || value.fit.length > 20 || !value.fit.every(item => isPlainObject(item) &&
      Object.keys(item).every(key => ['requirement', 'status', 'comment'].includes(key)) &&
      ['requirement', 'status', 'comment'].every(key => key in item) && typeof item.requirement === 'string' && item.requirement.length <= 300 &&
      ['yes', 'partial', 'no'].includes(item.status) && typeof item.comment === 'string' && item.comment.length <= 1000))) return false;
  if ('experienceDetails' in value && (!Array.isArray(value.experienceDetails) ||
      value.experienceDetails.length !== source.experience.length || value.experienceDetails.length > 5 ||
      !value.experienceDetails.every(details => Array.isArray(details) && details.length <= 10 &&
        details.every(item => typeof item === 'string' && item.length <= 500)))) return false;
  return true;
}

export function createAcceptedReportDrafts({ sourceRead, store, readInstructions = async () => ({ kind: 'found', body: {
  effective: { includeGuidance: [], styleGuidance: [], recruiterNotes: [] }, scopes: [] } }),
generateFields = null, generateTimeoutMs = 30_000, clock = () => new Date() } = {}) {
  if (typeof sourceRead !== 'function' || !store ||
      !['create', 'get', 'update', 'getPolicy'].every(method => typeof store[method] === 'function') ||
      typeof readInstructions !== 'function' || generateFields !== null && typeof generateFields !== 'function' ||
      !Number.isSafeInteger(generateTimeoutMs) || generateTimeoutMs < 1 || generateTimeoutMs > 120_000 ||
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
    let policy;
    try { policy = await store.getPolicy(context.profileId, record.candidateId, record.vacancyId); }
    catch { return { kind: 'policy_unavailable' }; }
    const policyRevision = policy?.revision ?? 0;
    if (record.policyRevision !== policyRevision) return { kind: 'stale_policy', policyRevision };
    const violations = checkReportPolicy(record.clientFields, policy ?? { forbiddenPhrases: [] });
    if (violations.length) return { kind: 'policy_violation', violations, policyRevision };
    return { kind: 'current', source: result.body, policy, policyRevision };
  }

  return {
    async previousApproved(context, candidateId, vacancyId, excludeReportRef = null) {
      if (!safeId(context?.profileId) || !safeId(candidateId) || !safeId(vacancyId) ||
          excludeReportRef !== null && !/^report_[a-f0-9]{32}$/.test(excludeReportRef) ||
          typeof store.listApprovedVersions !== 'function') return { kind: 'invalid_request' };
      let records;
      try { records = await store.listApprovedVersions(context.profileId, candidateId, vacancyId, 20); }
      catch { return { kind: 'store_unavailable' }; }
      const record = records.find(item => item.candidateId === candidateId && item.vacancyId === vacancyId &&
        item.reportRef !== excludeReportRef && item.reviewState === 'approved');
      return { kind: 'found', report: record ? { reportRef: record.reportRef,
        reportRevision: revisionOf(record.revision), candidateId, vacancyId,
        approvedAt: record.updatedAt, clientFields: structuredClone(record.clientFields),
        fieldProvenance: structuredClone(record.fieldProvenance ?? {}) } : null };
    },
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
      let policy;
      try { policy = await store.getPolicy(context.profileId, request.candidateId, request.vacancyId); }
      catch { return { kind: 'policy_unavailable' }; }
      const policyRevision = policy?.revision ?? 0;
      const expectedPolicyRevision = request.expectedPolicyRevision ?? 0;
      if (!Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision !== policyRevision)
        return { kind: 'stale_policy', policyRevision };
      const violations = checkReportPolicy(source.clientDraftFields, policy ?? { forbiddenPhrases: [] });
      if (violations.length) return { kind: 'policy_violation', violations, policyRevision };
      const now = clock().toISOString();
      const record = {
        reportRef: reportRef(), profileId: context.profileId, sourceKind,
        candidateId: request.candidateId, vacancyId: request.vacancyId,
        sourceRevision: source.sourceRevision, policyRevision, revision: 1, status: 'draft', reviewState: 'unreviewed',
        clientFields: { ...structuredClone(source.clientDraftFields), experience: source.clientDraftFields.experience.map(item => ({ ...item, details: [] })), summary: '', fit: [], conclusion: '' }, createdAt: now, updatedAt: now,
        fieldProvenance: Object.fromEntries(['candidateName', 'position', 'vacancyTitle', 'experience',
          'education', 'courses', 'skills', 'languages', 'location'].filter(field => field in source.clientDraftFields &&
          (Array.isArray(source.clientDraftFields[field]) ? source.clientDraftFields[field].length > 0 : Boolean(source.clientDraftFields[field]))).map(field =>
          [field, { kind: 'source', sourceRevision: source.sourceRevision }])),
        audit: [{ action: 'draft_created', revision: 1, actorProfileId: context.profileId, at: now, sourceRevision: source.sourceRevision }],
      };
      const created = await store.create({ profileId: context.profileId, idempotencyKey: key,
        requestFingerprint: JSON.stringify([sourceKind, request.candidateId, request.vacancyId, request.expectedSourceRevision, policyRevision]), record });
      if (created.kind === 'created' || created.kind === 'existing')
        return { kind: created.kind, report: publicReport(created.record) };
      if (created.kind === 'stale_policy') {
        const latest = await store.getPolicy(context.profileId, request.candidateId, request.vacancyId);
        return { kind: 'stale_policy', policyRevision: latest?.revision ?? 0 };
      }
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
    async exportApproved(context, ref, expectedReportRevision) {
      if (!safeId(context?.profileId) || !/^report_[a-f0-9]{32}$/.test(ref ?? '') ||
          !/^report-r[1-9][0-9]*$/.test(expectedReportRevision ?? '') ||
          typeof store.finalizeApprovedExport !== 'function') return { kind: 'invalid_request' };
      const record = await store.get(context.profileId, ref);
      if (!record) return { kind: 'not_found' };
      if (expectedReportRevision !== revisionOf(record.revision))
        return { kind: 'stale_report', report: publicReport(record) };
      const current = await currentSource(context, record);
      if (current.kind !== 'current') return { kind: current.kind, report: publicReport(record) };
      if (record.status !== 'draft' || record.reviewState !== 'approved')
        return { kind: 'not_approved', report: publicReport(record) };
      const finalized = await store.finalizeApprovedExport({ profileId: context.profileId,
        reportRef: ref, expectedRevision: record.revision, occurredAt: clock().toISOString() });
      if (finalized.kind !== 'exported') return finalized;
      return { kind: 'exported', report: publicReport(finalized.record),
        html: renderClientDraft(finalized.record, { approved: true }) };
    },
    async edit(context, ref, expectedReportRevision, clientEdits) {
      if (!safeId(context?.profileId) || !/^report_[a-f0-9]{32}$/.test(ref ?? '') ||
          !/^report-r[1-9][0-9]*$/.test(expectedReportRevision ?? '') || !validClientEdits(clientEdits))
        return { kind: 'invalid_request' };
      const record = await store.get(context.profileId, ref);
      if (!record) return { kind: 'not_found' };
      const current = await currentSource(context, record);
      if (current.kind !== 'current') return { kind: current.kind, report: publicReport(record) };
      if (record.status !== 'draft' || record.reviewState === 'approved') return { kind: 'not_editable', report: publicReport(record) };
      if (expectedReportRevision !== revisionOf(record.revision)) return { kind: 'stale_report', report: publicReport(record) };
      const clientFields = { ...record.clientFields, ...structuredClone(clientEdits) };
      if (!validClientFields(clientFields)) return { kind: 'invalid_request' };
      const changedFields = Object.keys(clientEdits).filter(field =>
        JSON.stringify(record.clientFields[field]) !== JSON.stringify(clientFields[field]));
      if (!changedFields.length) return { kind: 'edited', report: publicReport(record) };
      const violations = checkReportPolicy(clientFields, current.policy ?? { forbiddenPhrases: [] });
      if (violations.length) return { kind: 'policy_violation', violations,
        policyRevision: current.policyRevision };
      const now = clock().toISOString();
      const fieldProvenance = structuredClone(record.fieldProvenance ?? {});
      for (const field of changedFields) fieldProvenance[field] = { kind: 'recruiter',
        editedAt: now };
      const updated = { ...record, clientFields, fieldProvenance, policyRevision: current.policyRevision, revision: record.revision + 1,
        reviewState: 'unreviewed', updatedAt: now,
        audit: [...record.audit, { action: 'client_fields_edited', revision: record.revision + 1,
          actorProfileId: context.profileId, at: now, sourceRevision: record.sourceRevision,
          fields: changedFields.sort() }] };
      const result = await store.update(context.profileId, ref, record.revision, updated);
      if (result.kind === 'stale_policy') {
        const latest = await store.getPolicy(context.profileId, record.candidateId, record.vacancyId);
        return { kind: 'stale_policy', policyRevision: latest?.revision ?? 0 };
      }
      return result.kind === 'updated' ? { kind: 'edited', report: publicReport(result.record) } : result;
    },
    async regenerate(context, ref, expectedReportRevision, { replaceRecruiterEditedFields = false } = {}) {
      if (!safeId(context?.profileId) || !/^report_[a-f0-9]{32}$/.test(ref ?? '') ||
          !/^report-r[1-9][0-9]*$/.test(expectedReportRevision ?? '') || typeof replaceRecruiterEditedFields !== 'boolean')
        return { kind: 'invalid_request' };
      const record = await store.get(context.profileId, ref);
      if (!record) return { kind: 'not_found' };
      if (record.status !== 'draft' || record.reviewState === 'approved') return { kind: 'not_editable', report: publicReport(record) };
      if (expectedReportRevision !== revisionOf(record.revision)) return { kind: 'stale_report', report: publicReport(record) };
      if (typeof generateFields !== 'function') return { kind: 'generation_unavailable' };
      const current = await currentSource(context, record);
      if (current.kind !== 'current') return { kind: current.kind, report: publicReport(record) };
      let applicable;
      try { applicable = await readInstructions(context, { candidateId: record.candidateId,
        vacancyId: record.vacancyId, sourceKind: record.sourceKind,
        reportRef: record.reportRef, reportRevision: revisionOf(record.revision) }); }
      catch { return { kind: 'instructions_unavailable' }; }
      if (applicable?.kind !== 'found') return { kind: applicable?.kind === 'stale_report' ? 'stale_report' : 'instructions_unavailable' };
      const provenance = record.fieldProvenance ?? {};
      const previouslyEdited = new Set(Object.entries(provenance)
        .filter(([, value]) => value?.kind === 'recruiter').map(([field]) => field));
      // Old drafts predate provenance. Preserve non-empty hand-authored text by default.
      for (const field of ['summary', 'fit', 'conclusion']) if (!(field in provenance) &&
          (field === 'fit' ? record.clientFields.fit?.length > 0 : Boolean(record.clientFields[field]?.trim()))) previouslyEdited.add(field);
      if (!('experience' in provenance) && record.clientFields.experience.some(item => item.details?.length)) previouslyEdited.add('experience');
      const candidates = ['summary', 'fit', 'conclusion', 'experienceDetails'];
      const fieldsToGenerate = candidates.filter(field => {
        const editedField = field === 'experienceDetails' ? 'experience' : field;
        return replaceRecruiterEditedFields || !previouslyEdited.has(editedField);
      });
      if (!fieldsToGenerate.length) return { kind: 'no_fields_to_regenerate', report: publicReport(record) };
      const request = {
        sourceRevision: current.source.sourceRevision,
        source: structuredClone(current.source.clientDraftFields),
        previousFields: structuredClone(record.clientFields),
        fieldsToGenerate,
        instructions: structuredClone(applicable.body.effective),
        forbiddenPhrases: [...(current.policy?.forbiddenPhrases ?? [])],
      };
      let generated;
      const controller = new AbortController();
      let timeout;
      try {
        const expired = new Promise((_, reject) => { timeout = setTimeout(() => {
          controller.abort(); reject(new Error('report_generation_timeout'));
        }, generateTimeoutMs); });
        generated = await Promise.race([generateFields({ ...request, signal: controller.signal }), expired]);
      } catch { return { kind: 'generation_unavailable' }; }
      finally { clearTimeout(timeout); }
      if (!validGeneratedFields(generated, current.source.clientDraftFields) ||
          Object.keys(generated).some(field => !fieldsToGenerate.includes(field))) return { kind: 'generation_invalid' };
      const clientFields = { ...record.clientFields };
      for (const field of ['summary', 'fit', 'conclusion']) if (field in generated) clientFields[field] = structuredClone(generated[field]);
      if ('experienceDetails' in generated) clientFields.experience = clientFields.experience.map((item, index) =>
        ({ ...item, details: [...generated.experienceDetails[index]] }));
      if (!validClientFields(clientFields)) return { kind: 'generation_invalid' };
      const violations = checkReportPolicy(clientFields, current.policy ?? { forbiddenPhrases: [] });
      if (violations.length) return { kind: 'policy_violation', violations, policyRevision: current.policyRevision };
      const latestSource = await currentSource(context, record);
      if (latestSource.kind !== 'current') return { kind: latestSource.kind, report: publicReport(record) };
      let latestInstructions;
      try { latestInstructions = await readInstructions(context, { candidateId: record.candidateId,
        vacancyId: record.vacancyId, sourceKind: record.sourceKind,
        reportRef: record.reportRef, reportRevision: revisionOf(record.revision) }); }
      catch { return { kind: 'instructions_unavailable' }; }
      if (latestInstructions?.kind !== 'found' || JSON.stringify(latestInstructions.body.scopes.map(item => [item.scopeType, item.revision])) !==
          JSON.stringify(applicable.body.scopes.map(item => [item.scopeType, item.revision]))) return { kind: 'stale_instructions' };
      const now = clock().toISOString();
      const fieldProvenance = structuredClone(provenance);
      const instructionRevisions = Object.fromEntries(applicable.body.scopes.map(item => [item.scopeType, item.revision]));
      for (const field of Object.keys(generated)) fieldProvenance[field === 'experienceDetails' ? 'experience' : field] = {
        kind: 'generated', sourceRevision: record.sourceRevision, generatedAt: now, instructionRevisions };
      const updated = { ...record, clientFields, fieldProvenance, policyRevision: latestSource.policyRevision,
        revision: record.revision + 1, reviewState: 'unreviewed', updatedAt: now,
        audit: [...record.audit, { action: 'report_regenerated', revision: record.revision + 1,
          actorProfileId: context.profileId, at: now, sourceRevision: record.sourceRevision,
          fields: Object.keys(generated).sort(), instructionRevisions }] };
      const saved = await store.update(context.profileId, ref, record.revision, updated);
      if (saved.kind === 'stale_policy') {
        const latestPolicy = await store.getPolicy(context.profileId, record.candidateId, record.vacancyId);
        return { kind: 'stale_policy', policyRevision: latestPolicy?.revision ?? 0 };
      }
      return saved.kind === 'updated' ? { kind: 'regenerated', report: publicReport(saved.record) } : saved;
    },
  };
}

export function createMemoryAcceptedReportDraftStore() {
  const byRef = new Map(); const byKey = new Map();
  const approvedVersions = [];
  const exportAudit = [];
  const policies = new Map();
  const instructionRecords = new Map();
  const instructionKey = (profileId, scopeType, scopeId) => JSON.stringify([profileId, scopeType, scopeId]);
  return {
    getReportInstructions(profileId, scopeType, scopeId) {
      const record = instructionRecords.get(instructionKey(profileId, scopeType, scopeId));
      return record ? structuredClone(record) : null;
    },
    replaceReportInstructions({ profileId, scopeType, scopeId, expectedRevision, record }) {
      const key = instructionKey(profileId, scopeType, scopeId);
      const current = instructionRecords.get(key) ?? null;
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) return { kind: 'stale_instructions', record: current && structuredClone(current) };
      if (current && JSON.stringify(current.instructions) === JSON.stringify(record.instructions))
        return { kind: 'existing', record: structuredClone(current) };
      const historyEntry = { revision: revision + 1, updatedAt: record.updatedAt,
        instructions: structuredClone(record.instructions) };
      const next = { ...structuredClone(record), revision: revision + 1,
        history: [...(current?.history ?? []), historyEntry].slice(-100),
        audit: [...(current?.audit ?? []), { action: 'instructions_updated', revision: revision + 1,
          actorProfileId: profileId, at: record.updatedAt, counts: Object.fromEntries(
            Object.entries(record.instructions).map(([field, items]) => [field, items.length])) }].slice(-100) };
      instructionRecords.set(key, next);
      return { kind: 'updated', record: structuredClone(next) };
    },
    getPolicy(profileId, candidateId, vacancyId) {
      const value = policies.get(JSON.stringify([profileId, candidateId, vacancyId]));
      return value ? structuredClone(value) : null;
    },
    replacePolicy({ profileId, candidateId, vacancyId, expectedRevision, record }) {
      const key = JSON.stringify([profileId, candidateId, vacancyId]);
      const current = policies.get(key) ?? null;
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) return { kind: 'stale_policy', policy: current && structuredClone(current) };
      if (current && JSON.stringify(current.forbiddenPhrases) === JSON.stringify(record.forbiddenPhrases))
        return { kind: 'existing', policy: structuredClone(current) };
      const next = { ...structuredClone(record), revision: revision + 1,
        audit: [...(current?.audit ?? []), { action: 'policy_updated', revision: revision + 1,
          actorProfileId: profileId, at: record.updatedAt, forbiddenCount: record.forbiddenPhrases.length }] };
      policies.set(key, next);
      return { kind: 'updated', policy: structuredClone(next) };
    },
    create({ profileId, idempotencyKey, requestFingerprint, record }) {
      const key = JSON.stringify([profileId, idempotencyKey]);
      const existing = byKey.get(key);
      if (existing) {
        const prior = byRef.get(existing);
        return prior?.requestFingerprint === requestFingerprint
          ? { kind: 'existing', record: structuredClone(prior.record) } : { kind: 'idempotency_conflict' };
      }
      const policyRevision = policies.get(JSON.stringify([profileId, record.candidateId, record.vacancyId]))?.revision ?? 0;
      if (policyRevision !== record.policyRevision) return { kind: 'stale_policy' };
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
      const policyRevision = policies.get(JSON.stringify([profileId, next.candidateId, next.vacancyId]))?.revision ?? 0;
      if (policyRevision !== next.policyRevision) return { kind: 'stale_policy' };
      if (next.reviewState === 'approved' && current.reviewState !== 'approved')
        approvedVersions.push(structuredClone(next));
      byRef.get(ref).record = structuredClone(next);
      return { kind: 'updated', record: structuredClone(next) };
    },
    listApprovedVersions(profileId, candidateId, vacancyId, limit = 20) {
      return approvedVersions.filter(record => record.profileId === profileId && record.candidateId === candidateId &&
        record.vacancyId === vacancyId && record.reviewState === 'approved')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.revision - a.revision)
        .slice(0, limit).map(record => structuredClone(record));
    },
    finalizeApprovedExport({ profileId, reportRef, expectedRevision, occurredAt }) {
      const current = byRef.get(reportRef)?.record;
      if (!current || current.profileId !== profileId) return { kind: 'not_found' };
      if (current.revision !== expectedRevision) return { kind: 'stale_report', record: publicReport(current) };
      if (current.status !== 'draft' || current.reviewState !== 'approved')
        return { kind: 'not_approved', record: publicReport(current) };
      const policyRevision = policies.get(JSON.stringify([profileId, current.candidateId, current.vacancyId]))?.revision ?? 0;
      if (policyRevision !== current.policyRevision) return { kind: 'stale_policy', policyRevision };
      const approved = approvedVersions.find(record => record.profileId === profileId &&
        record.reportRef === reportRef && record.revision === expectedRevision &&
        record.reviewState === 'approved' && record.sourceRevision === current.sourceRevision &&
        record.policyRevision === current.policyRevision);
      if (!approved) return { kind: 'not_approved', record: publicReport(current) };
      exportAudit.push({ owner: profileId, reportRef, reportRevision: expectedRevision,
        sourceRevision: current.sourceRevision, policyRevision: current.policyRevision,
        outcome: 'served', occurredAt });
      return { kind: 'exported', record: structuredClone(approved) };
    },
    listExportAudit(profileId, reportRef) {
      return exportAudit.filter(event => event.owner === profileId && event.reportRef === reportRef)
        .map(({ owner, ...event }) => structuredClone(event));
    },
  };
}
