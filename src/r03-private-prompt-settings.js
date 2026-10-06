const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));
const normalize = value => {
  const lines = typeof value === 'string' ? value.split('\n') : value;
  if (!Array.isArray(lines) || lines.length > 100) return null;
  const queries = lines.map(line => typeof line === 'string' ? line.trim() : null).filter(line => line !== '');
  if (queries.some(line => line === null || line.length > 500) || queries.length > 15 ||
      new Set(queries).size !== queries.length) return null;
  return queries;
};

// Query editing is owned by the recruiting app. It never writes the frozen
// source query file; the shared search plan reads the target-side override.
export function createR03PrivatePromptSettings({ loadBasePlan, queryOverrides, isVacancyOwned,
  clock = () => new Date() } = {}) {
  if (typeof loadBasePlan !== 'function' || typeof queryOverrides?.get !== 'function' ||
      typeof queryOverrides?.save !== 'function' || typeof isVacancyOwned !== 'function' ||
      typeof clock !== 'function') throw new TypeError('private_prompt_ports_required');
  const scope = (context, vacancyId) => safeId(context?.profileId) &&
    context.scopes?.includes('recruiting.candidateSearch') && safeId(vacancyId) &&
    isVacancyOwned(context.profileId, vacancyId);
  const unavailable = { status: 503, body: { error: 'search_plan_unavailable' } };
  async function read(context, vacancyId) {
    if (!scope(context, vacancyId)) return { status: 404, body: { error: 'vacancy_not_found' } };
    try {
      const plan = await loadBasePlan(context.profileId, vacancyId);
      const override = queryOverrides.get(context.profileId, vacancyId);
      if (plan?.profileId !== context.profileId || plan?.vacancyId !== vacancyId ||
          !Array.isArray(plan.queryCache?.queries) || !plan.queryCache?.revision)
        return unavailable;
      return { status: 200, body: { ok: true, vacancy_id: vacancyId,
        queries: plan.queryCache.queries, queries_manual: plan.queryCache.manual === true,
        queries_generated_at: override.mode === 'manual' ? override.updatedAt : null,
        query_revision: plan.queryCache.revision, override_revision: override.revision } };
    } catch { return unavailable; }
  }
  async function save(context, command) {
    if (!exact(command, ['vacancy_id', 'queries', 'expected_revision', 'expected_override_revision']) ||
        !safeId(command.vacancy_id))
      return { status: 400, body: { error: 'invalid_prompt_command' } };
    if (!scope(context, command.vacancy_id)) return { status: 404, body: { error: 'vacancy_not_found' } };
    if (typeof command.expected_revision !== 'string' ||
        !/^queries-[a-f0-9]{24}$/.test(command.expected_revision) ||
        !Number.isSafeInteger(command.expected_override_revision) || command.expected_override_revision < 0)
      return { status: 400, body: { error: 'invalid_prompt_command' } };
    const queries = normalize(command.queries);
    if (queries === null) return { status: 400, body: { error: 'invalid_queries' } };
    const current = await read(context, command.vacancy_id);
    if (current.status !== 200) return current;
    if (current.body.query_revision !== command.expected_revision ||
        current.body.override_revision !== command.expected_override_revision)
      return { status: 409, body: { error: 'query_revision_conflict',
        current_revision: current.body.query_revision,
        current_override_revision: current.body.override_revision } };
    if (queries.length && JSON.stringify(queries) === JSON.stringify(current.body.queries))
      return { status: 200, body: { ...current.body, queries_state: 'unchanged' } };
    let result;
    try { result = queryOverrides.save(context.profileId, command.vacancy_id,
      command.expected_override_revision, queries.length ? queries : null, clock().toISOString()); }
    catch { return unavailable; }
    if (result.kind === 'conflict') return { status: 409, body: { error: 'query_revision_conflict',
      current_override_revision: result.currentRevision } };
    if (!queries.length) return { status: 202, body: { ok: true, vacancy_id: command.vacancy_id,
      queries_state: 'reset', queries_manual: false, override_revision: result.state.revision,
      pending_regeneration: true } };
    const updated = await read(context, command.vacancy_id);
    return updated.status === 200 ? { status: 200, body: { ...updated.body, queries_state: 'manual' } } :
      { status: 202, body: { ok: true, vacancy_id: command.vacancy_id, queries_state: 'manual',
        override_revision: result.state.revision, pending_read: true } };
  }
  return { read, save };
}
