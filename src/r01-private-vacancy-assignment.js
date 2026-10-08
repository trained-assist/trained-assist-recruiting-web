import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validPlan = plan => object(plan) && plan.version === 1 && Array.isArray(plan.stages) &&
  plan.stages.length <= 100 && new Set(plan.stages.map(stage => stage.id)).size === plan.stages.length &&
  plan.stages.every(stage => object(stage) && safeId(stage.id) &&
    ['title', 'instruction', 'completion_result', 'material'].every(key =>
      typeof stage[key] === 'string' && stage[key].length <= 16000) &&
    ['verbatim', 'context'].includes(stage.material_mode));

function privateSource(binding, profileId, vacancyId) {
  if (binding?.profileId !== profileId || typeof binding.contextDirectory !== 'string' ||
      !lstatSync(binding.contextDirectory).isDirectory() || lstatSync(binding.contextDirectory).mode & 0o077)
    throw new Error('invalid_binding');
  const fd = openSync(join(binding.contextDirectory, `ats_config:${vacancyId}.json`),
    constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
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
    return { config, sourceSha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { closeSync(fd); }
}

function savedSidecar(binding, profileId, vacancyId, sourceSha256) {
  const path = join(binding.contextDirectory, `ats_communication_plan:${vacancyId}.json`);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.mode & 0o077 || info.size < 1 || info.size > 2 * 1024 * 1024)
      throw new Error('invalid_saved_plan');
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (value?.profileId !== profileId || value?.vacancyId !== vacancyId ||
        value?.sourceSha256 !== sourceSha256 || !validPlan(value?.plan) || !hex(value?.revisionSha256) ||
        digest(JSON.stringify({ profileId, vacancyId, sourceSha256, plan: value.plan })) !== value.revisionSha256)
      throw new Error('invalid_saved_plan');
    return value;
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

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
    try {
      const binding = await resolveProfileBinding(profileId);
      const { config, sourceSha256 } = privateSource(binding, profileId, vacancyId);
      const saved = savedSidecar(binding, profileId, vacancyId, sourceSha256);
      const plan = saved?.plan ?? config.communication_plan;
      if (plan !== undefined && !validPlan(plan)) throw new Error('invalid_plan');
      const stages = plan?.stages;
      const legacy = typeof config.test_task === 'string' ? config.test_task : '';
      const materials = stages === undefined
        ? legacy.trim() ? [{ stageId: 'legacy_test_task', title: 'Тестовое задание',
          material: legacy, materialMode: 'verbatim', sha256: digest(legacy) }] : []
        : stages.filter(stage => stage.material_mode === 'verbatim' && stage.material.trim())
          .map(stage => ({ stageId: stage.id, title: stage.title, material: stage.material,
            materialMode: 'verbatim', sha256: digest(stage.material) }));
      return { status: 200, body: { domainApiVersion: 'v1', profileId, vacancyId,
        sourceSha256, planRevisionSha256: saved?.revisionSha256 ?? null,
        reviewStatus: stages === undefined ? 'legacy_draft_requires_review' : 'saved_plan',
        materials, draftPlan: stages === undefined && legacy.trim() ? { version: 1, stages: [{ id: 'legacy_test_task',
          title: 'Тестовое задание', instruction: '', completion_result: '', material_mode: 'verbatim', material: legacy }] } : null,
        legacyConflict: stages !== undefined && legacy.trim() &&
          !materials.some(item => item.material === legacy) } };
    } catch (error) {
      return { status: error?.code === 'ENOENT' ? 404 : 503,
        body: { error: error?.code === 'ENOENT' ? 'assignment_not_found' : 'assignment_unavailable' } };
    }
  };
}

// First reviewed revision only. The file is immutable; later edits require a
// separately designed revision transition and must not silently replace it.
export function createPrivateVacancyAssignmentSave({ resolveProfileBinding, isVacancyOwned } = {}) {
  if (typeof resolveProfileBinding !== 'function' || typeof isVacancyOwned !== 'function')
    throw new TypeError('private_assignment_binding_required');
  return async (context, request) => {
    const { profileId, sub } = context ?? {};
    const { vacancyId, sourceSha256, plan, reviewed } = request ?? {};
    if (!safeId(profileId) || !safeId(sub) || !safeId(vacancyId) || !hex(sourceSha256) ||
        reviewed !== true || !validPlan(plan) || plan.stages.length === 0)
      return { status: 400, body: { error: 'invalid_assignment_review' } };
    if (!isVacancyOwned(profileId, vacancyId)) return { status: 404, body: { error: 'vacancy_not_found' } };
    try {
      const binding = await resolveProfileBinding(profileId);
      const source = privateSource(binding, profileId, vacancyId);
      if (source.sourceSha256 !== sourceSha256) return { status: 409, body: { error: 'assignment_source_changed' } };
      if (source.config.communication_plan !== undefined)
        return { status: 409, body: { error: 'source_plan_already_saved' } };
      const legacy = source.config.test_task;
      if (typeof legacy !== 'string' || !legacy.trim() ||
          !plan.stages.some(stage => stage.material_mode === 'verbatim' && stage.material === legacy))
        return { status: 409, body: { error: 'legacy_material_mismatch' } };
      const revisionSha256 = digest(JSON.stringify({ profileId, vacancyId, sourceSha256, plan }));
      const prior = savedSidecar(binding, profileId, vacancyId, sourceSha256);
      if (prior) return prior.revisionSha256 === revisionSha256
        ? { status: 200, body: { profileId, vacancyId, sourceSha256, revisionSha256, reviewStatus: 'saved_plan' } }
        : { status: 409, body: { error: 'assignment_revision_conflict' } };
      const path = join(binding.contextDirectory, `ats_communication_plan:${vacancyId}.json`);
      const value = { profileId, vacancyId, sourceSha256, revisionSha256, reviewedBy: sub, plan };
      const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
      let fd; let created = false;
      try {
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = true;
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        linkSync(temporary, path);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          const existing = savedSidecar(binding, profileId, vacancyId, sourceSha256);
          return existing?.revisionSha256 === revisionSha256
            ? { status: 200, body: { profileId, vacancyId, sourceSha256, revisionSha256, reviewStatus: 'saved_plan' } }
            : { status: 409, body: { error: 'assignment_revision_conflict' } };
        }
        throw error;
      } finally { if (fd !== undefined) closeSync(fd); if (created) unlinkSync(temporary); }
      return { status: 201, body: { profileId, vacancyId, sourceSha256, revisionSha256, reviewStatus: 'saved_plan' } };
    } catch (error) {
      return { status: error?.code === 'ENOENT' ? 404 : 503,
        body: { error: error?.code === 'ENOENT' ? 'assignment_not_found' : 'assignment_unavailable' } };
    }
  };
}
