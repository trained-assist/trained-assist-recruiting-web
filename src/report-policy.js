const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const normalized = value => value.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();

export function normalizeReportPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).join(',') !== 'forbiddenPhrases' || !Array.isArray(value.forbiddenPhrases) ||
      value.forbiddenPhrases.length > 50) return null;
  const lists = [value.forbiddenPhrases].map(items => {
    if (!items.every(item => typeof item === 'string' && item.trim() && item.trim().length <= 200)) return null;
    const clean = items.map(item => item.trim());
    return new Set(clean.map(normalized)).size === clean.length ? clean : null;
  });
  return lists.some(list => list === null) ? null : { forbiddenPhrases: lists[0] };
}

function collectStrings(value, path = '', output = []) {
  if (typeof value === 'string') output.push({ path, value });
  else if (Array.isArray(value)) value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, output));
  else if (value && typeof value === 'object')
    Object.entries(value).forEach(([key, item]) => collectStrings(item, path ? `${path}.${key}` : key, output));
  return output;
}

export function checkReportPolicy(clientFields, policy) {
  const fields = collectStrings(clientFields);
  const text = fields.map(field => ({ ...field, normalized: normalized(field.value) }));
  const violations = [];
  for (let index = 0; index < policy.forbiddenPhrases.length; index++) {
    const phrase = normalized(policy.forbiddenPhrases[index]);
    for (const field of text) if (field.normalized.includes(phrase))
      violations.push({ fieldPath: field.path, rule: 'forbidden', ruleIndex: index });
  }
  return violations;
}

export function createReportPolicyService({ sourceRead, store, clock = () => new Date() } = {}) {
  if (typeof sourceRead !== 'function' || typeof store?.getPolicy !== 'function' ||
      typeof store?.replacePolicy !== 'function' || typeof clock !== 'function')
    throw new TypeError('report_policy_ports_required');
  const empty = (profileId, candidateId, vacancyId) => ({ profileId, candidateId, vacancyId,
    revision: 0, requiredPhrases: [], forbiddenPhrases: [], updatedAt: null, audit: [] });
  async function currentSource(context, { candidateId, vacancyId, sourceKind }) {
    if (!safeId(context?.profileId) || !safeId(candidateId) || !safeId(vacancyId) ||
        !['accepted_cold_search', 'accepted_hh_response'].includes(sourceKind)) return { kind: 'invalid_request' };
    let result;
    try { result = await sourceRead(context, { candidateId, vacancyId, sourceKind }); }
    catch { return { kind: 'source_unavailable' }; }
    if (result?.status === 404) return { kind: 'source_not_found' };
    if (result?.status === 409) return { kind: 'stale_source' };
    if (result?.status !== 200 || result.body?.profileId !== context.profileId ||
        result.body?.candidateId !== candidateId || result.body?.vacancyId !== vacancyId ||
        result.body?.sourceKind !== sourceKind || result.body?.publication !== 'disabled')
      return { kind: 'source_unavailable' };
    return { kind: 'current' };
  }
  function publicPolicy(policy) {
    return { domainApiVersion: 'v1', candidateId: policy.candidateId, vacancyId: policy.vacancyId,
      policyRevision: `policy-r${policy.revision}`, forbiddenPhrases: [...policy.forbiddenPhrases],
      updatedAt: policy.updatedAt };
  }
  return {
    async get(context, params) {
      const source = await currentSource(context, params);
      if (source.kind !== 'current') return source;
      let policy;
      try {
        policy = await store.getPolicy(context.profileId, params.candidateId, params.vacancyId) ??
          empty(context.profileId, params.candidateId, params.vacancyId);
      } catch { return { kind: 'policy_unavailable' }; }
      return { kind: 'found', policy: publicPolicy(policy) };
    },
    async update(context, params, expectedRevision, value) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { kind: 'invalid_request' };
      const policy = normalizeReportPolicy(value);
      if (!policy) return { kind: 'invalid_request' };
      const source = await currentSource(context, params);
      if (source.kind !== 'current') return source;
      const record = { ...policy, profileId: context.profileId, candidateId: params.candidateId,
        vacancyId: params.vacancyId, revision: expectedRevision + 1,
        updatedAt: clock().toISOString(), actorProfileId: context.profileId };
      let result;
      try {
        result = await store.replacePolicy({ profileId: context.profileId,
          candidateId: params.candidateId, vacancyId: params.vacancyId,
          expectedRevision, record });
      } catch { return { kind: 'policy_unavailable' }; }
      if (result.kind === 'stale_policy') return { kind: 'stale_policy',
        policyRevision: result.policy?.revision ?? 0 };
      return result.kind === 'updated' || result.kind === 'existing'
        ? { kind: result.kind, policy: publicPolicy(result.policy) } : result;
    },
  };
}
