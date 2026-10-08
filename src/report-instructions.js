const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sourceHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reportRefPattern = /^report_[a-f0-9]{32}$/;
const SCOPE_ORDER = ['profile', 'vacancy', 'candidate', 'report_version'];
const MAX_TOTAL_INSTRUCTION_CHARS = 8000;
const emptyInstructions = () => ({ includeGuidance: [], styleGuidance: [], recruiterNotes: [] });
const fail = kind => ({ kind });

function validInstructions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'includeGuidance,recruiterNotes,styleGuidance') return false;
  return ['includeGuidance', 'styleGuidance', 'recruiterNotes'].every(key =>
    Array.isArray(value[key]) && value[key].length <= 30 &&
    value[key].every(item => typeof item === 'string' && item.trim() && item.length <= 1000)) &&
    Object.values(value).flat().reduce((total, item) => total + item.length, 0) <= MAX_TOTAL_INSTRUCTION_CHARS;
}

function normalizeInstructions(value) {
  if (!validInstructions(value)) return null;
  return { includeGuidance: value.includeGuidance.map(item => item.trim()),
    styleGuidance: value.styleGuidance.map(item => item.trim()),
    recruiterNotes: value.recruiterNotes.map(item => item.trim()) };
}

function scopeIdFor(type, profileId, params) {
  if (type === 'profile') return profileId;
  if (type === 'vacancy') return params.vacancyId;
  if (type === 'candidate') return params.candidateId;
  if (type === 'report_version') return `${params.reportRef}_${params.reportRevision}`;
  return null;
}

function publicScope(record) {
  return { scopeType: record.scopeType, ...(record.scopeType === 'profile' ? {} : { scopeId: record.scopeId }),
    revision: record.revision, updatedAt: record.updatedAt, instructions: structuredClone(record.instructions),
    history: structuredClone(record.history ?? []) };
}

function compose(scopes) {
  const effective = emptyInstructions();
  const provenance = [];
  for (const scope of scopes) {
    for (const field of Object.keys(effective)) for (const text of scope.instructions[field]) {
      effective[field].push(text);
      provenance.push({ field, text, scopeType: scope.scopeType,
        ...(scope.scopeType === 'profile' ? {} : { scopeId: scope.scopeId }), revision: scope.revision });
    }
  }
  return { instructions: effective, provenance };
}

// Notes are private authoring guidance. They are loaded only after the report
// source proves the current profile/vacancy/candidate binding. Their precedence
// is stable and explicit: profile -> vacancy -> candidate -> report version.
export function createReportInstructions({ sourceRead, store, clock = () => new Date() } = {}) {
  if (typeof sourceRead !== 'function' || typeof store?.getReportInstructions !== 'function' ||
      typeof store?.replaceReportInstructions !== 'function' || typeof clock !== 'function')
    throw new TypeError('report_instruction_ports_required');

  async function validateContext(context, params) {
    if (!safeId(context?.profileId) || !safeId(params?.vacancyId) || !safeId(params?.candidateId) ||
        !['accepted_cold_search', 'accepted_hh_response'].includes(params.sourceKind ?? 'accepted_cold_search') ||
        (params.reportRef === undefined) !== (params.reportRevision === undefined) ||
        params.reportRef !== undefined && (!reportRefPattern.test(params.reportRef) ||
          !/^report-r[1-9][0-9]*$/.test(params.reportRevision))) return fail('invalid_request');
    let result;
    try { result = await sourceRead(context, { vacancyId: params.vacancyId,
      candidateId: params.candidateId, sourceKind: params.sourceKind ?? 'accepted_cold_search' }); }
    catch { return fail('source_unavailable'); }
    if (result?.status === 404) return fail('source_not_found');
    if (result?.status === 409) return fail('stale_source');
    if (result?.status !== 200 || result.body?.profileId !== context.profileId ||
        result.body?.vacancyId !== params.vacancyId || result.body?.candidateId !== params.candidateId ||
        result.body?.sourceKind !== (params.sourceKind ?? 'accepted_cold_search') ||
        result.body?.publication !== 'disabled' || !sourceHash(result.body?.sourceRevision)) return fail('source_unavailable');
    let report = null;
    if (params.reportRef) {
      try { report = await store.get(context.profileId, params.reportRef); }
      catch { return fail('store_unavailable'); }
      if (!report || report.vacancyId !== params.vacancyId || report.candidateId !== params.candidateId ||
          report.sourceKind !== (params.sourceKind ?? 'accepted_cold_search')) return fail('not_found');
      if (report.sourceRevision !== result.body.sourceRevision) return fail('stale_source');
      if (`report-r${report.revision}` !== params.reportRevision) return fail('stale_report');
    }
    return { kind: 'current', source: result.body, report };
  }

  return {
    async getApplicable(context, params) {
      const checked = await validateContext(context, params);
      if (checked.kind !== 'current') return checked;
      const scopes = [];
      try {
        for (const scopeType of SCOPE_ORDER) {
          if (scopeType === 'report_version' && !params.reportRef) continue;
          const scopeId = scopeIdFor(scopeType, context.profileId, params);
          const value = await store.getReportInstructions(context.profileId, scopeType, scopeId);
          const record = value ?? { scopeType, scopeId, revision: 0, updatedAt: null,
            instructions: emptyInstructions(), history: [] };
          if (record.profileId && record.profileId !== context.profileId || record.scopeType !== scopeType ||
              record.scopeId !== scopeId || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
              !validInstructions(record.instructions) || !Array.isArray(record.history) || record.history.length > 100 ||
              !record.history.every(item => Number.isSafeInteger(item.revision) && item.revision > 0 &&
                typeof item.updatedAt === 'string' && validInstructions(item.instructions))) return fail('store_unavailable');
          scopes.push(record);
        }
      } catch { return fail('store_unavailable'); }
      const composed = compose(scopes);
      return { kind: 'found', body: { domainApiVersion: 'v1', candidateId: params.candidateId,
        vacancyId: params.vacancyId, sourceKind: params.sourceKind ?? 'accepted_cold_search',
        sourceRevision: checked.source.sourceRevision,
        ...(params.reportRef ? { reportRef: params.reportRef, reportRevision: params.reportRevision } : {}),
        scopes: scopes.map(publicScope),
        effective: composed.instructions, provenance: composed.provenance } };
    },
    async update(context, params, scopeType, expectedRevision, instructions) {
      if (!SCOPE_ORDER.includes(scopeType) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
          !validInstructions(instructions)) return fail('invalid_request');
      const checked = await validateContext(context, params);
      if (checked.kind !== 'current') return checked;
      if (scopeType === 'report_version' && !params.reportRef) return fail('invalid_request');
      if (scopeType === 'report_version' && (checked.report.status !== 'draft' || checked.report.reviewState === 'approved'))
        return fail('not_editable');
      const scopeId = scopeIdFor(scopeType, context.profileId, params);
      const now = clock().toISOString();
      const record = { profileId: context.profileId, scopeType, scopeId, revision: expectedRevision + 1,
        updatedAt: now, instructions: normalizeInstructions(instructions), actorProfileId: context.profileId };
      try {
        const result = await store.replaceReportInstructions({ profileId: context.profileId, scopeType, scopeId,
          expectedRevision, record });
        if (result.kind === 'stale_instructions') return { kind: 'stale_instructions', revision: result.record?.revision ?? 0 };
        if (result.kind === 'updated' || result.kind === 'existing') return { kind: result.kind, scope: publicScope(result.record) };
        return fail('store_unavailable');
      } catch { return fail('store_unavailable'); }
    },
  };
}

export { SCOPE_ORDER, validInstructions };
