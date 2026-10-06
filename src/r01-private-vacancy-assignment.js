import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');

// The legacy source is private per-vacancy data. This reader never adopts a
// legacy field as a live plan or sends it to HH.
export function createPrivateVacancyAssignmentRead({ resolveProfileBinding, isVacancyOwned } = {}) {
  if (typeof resolveProfileBinding !== 'function' || typeof isVacancyOwned !== 'function')
    throw new TypeError('private_assignment_binding_required');
  return async (context, { vacancyId } = {}) => {
    const profileId = context?.profileId;
    if (!safeId(profileId) || !safeId(vacancyId))
      return { status: 400, body: { error: 'invalid_assignment_request' } };
    if (!isVacancyOwned(profileId, vacancyId))
      return { status: 404, body: { error: 'vacancy_not_found' } };
    let fd;
    try {
      const binding = await resolveProfileBinding(profileId);
      if (binding?.profileId !== profileId || typeof binding.contextDirectory !== 'string' ||
          !lstatSync(binding.contextDirectory).isDirectory() ||
          lstatSync(binding.contextDirectory).mode & 0o077)
        throw new Error('invalid_binding');
      fd = openSync(join(binding.contextDirectory, `ats_config:${vacancyId}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.mode & 0o077 || info.size < 1 || info.size > 8 * 1024 * 1024)
        throw new Error('invalid_source');
      const bytes = readFileSync(fd);
      if (bytes.length !== info.size) throw new Error('changed_source');
      const record = JSON.parse(bytes.toString('utf8'));
      let config = record?.value;
      if (typeof config === 'string') config = JSON.parse(config);
      if (!object(config) || config.vacancy_id !== undefined && String(config.vacancy_id) !== vacancyId)
        throw new Error('wrong_vacancy');
      const stages = config.communication_plan?.stages;
      if (config.communication_plan !== undefined &&
          (config.communication_plan.version !== 1 || !Array.isArray(stages) || stages.length > 100 ||
           stages.some(stage => !object(stage) || !safeId(stage.id) ||
             !['title', 'instruction', 'completion_result', 'material'].every(key =>
               typeof stage[key] === 'string') ||
             !['verbatim', 'context'].includes(stage.material_mode))))
        throw new Error('invalid_plan');
      const legacy = typeof config.test_task === 'string' ? config.test_task : '';
      const materials = stages === undefined
        ? legacy.trim() ? [{ stageId: 'legacy_test_task', title: 'Тестовое задание',
          material: legacy, materialMode: 'verbatim', sha256: digest(legacy) }] : []
        : stages.filter(stage => stage.material_mode === 'verbatim' && stage.material.trim())
          .map(stage => ({ stageId: stage.id, title: stage.title, material: stage.material,
            materialMode: 'verbatim', sha256: digest(stage.material) }));
      return { status: 200, body: { domainApiVersion: 'v1', profileId, vacancyId,
        sourceSha256: createHash('sha256').update(bytes).digest('hex'),
        reviewStatus: stages === undefined ? 'legacy_draft_requires_review' : 'saved_plan',
        materials, legacyConflict: stages !== undefined && legacy.trim() &&
          !materials.some(item => item.material === legacy) } };
    } catch (error) {
      return { status: error?.code === 'ENOENT' ? 404 : 503,
        body: { error: error?.code === 'ENOENT' ? 'assignment_not_found' : 'assignment_unavailable' } };
    } finally { if (fd !== undefined) closeSync(fd); }
  };
}
