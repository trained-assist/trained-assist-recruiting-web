const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// This command marks exact HH resume IDs as already seen for one trusted
// profile/vacancy. It never infers an active vacancy or creates a candidate.
export function createR03PrivateSeenImport({ candidateState, isVacancyOwned,
  clock = () => new Date() } = {}) {
  if (typeof candidateState?.importSeen !== 'function' || typeof isVacancyOwned !== 'function' ||
      typeof clock !== 'function') throw new TypeError('private_seen_import_ports_required');
  return function importSeen(context, command) {
    if (!command || typeof command !== 'object' || Array.isArray(command) ||
        Object.keys(command).some(key => !['vacancy_id', 'ids'].includes(key)) ||
        !safeId(command.vacancy_id))
      return { status: 400, body: { error: 'invalid_seen_import' } };
    if (!safeId(context?.profileId) || !context.scopes?.includes('recruiting.candidateSearch') ||
        !isVacancyOwned(context.profileId, command.vacancy_id))
      return { status: 404, body: { error: 'vacancy_not_found' } };
    try {
      const result = candidateState.importSeen({ profileId: context.profileId,
        vacancyId: command.vacancy_id, ids: command.ids, importedAt: clock().toISOString() });
      return { status: 200, body: { ok: true, vacancy_id: command.vacancy_id, ...result } };
    } catch (error) {
      return error instanceof TypeError ? { status: 400, body: { error: 'invalid_seen_import' } } :
        { status: 503, body: { error: 'seen_import_unavailable' } };
    }
  };
}
