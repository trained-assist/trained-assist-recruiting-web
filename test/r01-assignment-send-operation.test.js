import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateVacancyAssignmentMaterialBinding } from '../src/r01-private-vacancy-assignment.js';

const sha = value => createHash('sha256').update(value).digest('hex');

test('material binding exposes only exact saved verbatim material and hashes for current source/profile', async t => {
  const root = mkdtempSync(join(tmpdir(), 'r01-assignment-operation-'));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contextDirectory = join(root, 'profile_A');
  mkdirSync(contextDirectory, { mode: 0o700 });
  const source = JSON.stringify({ value: { vacancy_id: 'vacancy_A', test_task: 'Legacy task' } });
  writeFileSync(join(contextDirectory, 'ats_config:vacancy_A.json'), source, { mode: 0o600 });
  const profileId = 'profile_A', vacancyId = 'vacancy_A';
  const plan = { version: 1, stages: [
    { id: 'brief', title: 'Assignment', instruction: '', completion_result: '',
      material_mode: 'verbatim', material: 'Exact reviewed assignment\nKeep spacing.' },
    { id: 'interview', title: 'Interview', instruction: 'Ask questions', completion_result: 'Notes',
      material_mode: 'context', material: '' }
  ] };
  const revisionSha256 = sha(JSON.stringify({ profileId, vacancyId, sourceSha256: sha(source), plan }));
  writeFileSync(join(contextDirectory, 'ats_communication_plan:vacancy_A.json'), JSON.stringify({
    profileId, vacancyId, sourceSha256: sha(source), revisionSha256, reviewedBy: 'reviewer_A', plan
  }), { mode: 0o600 });
  const bindMaterial = createPrivateVacancyAssignmentMaterialBinding({
    resolveProfileBinding: async id => id === profileId ? { profileId, contextDirectory } : null,
    isVacancyOwned: (id, vacancy) => id === profileId && vacancy === vacancyId
  });
  const result = await bindMaterial({ profileId }, { vacancyId });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { domainApiVersion: 'v1', profileId, vacancyId,
    sourceSha256: sha(source),
    savedPlanRevisionSha256: revisionSha256,
    materialSha256: sha('Exact reviewed assignment\nKeep spacing.'),
    message: 'Exact reviewed assignment\nKeep spacing.' });
  assert.equal((await bindMaterial({ profileId: 'profile_B' }, { vacancyId })).status, 404);
  assert.equal((await bindMaterial({ profileId }, { vacancyId: 'vacancy_B' })).status, 404);
  assert.equal(Object.hasOwn(result.body, 'agreementMessageId'), false,
    'agreement has to come from a separate fresh-history state transition');
});

test('material binding refuses legacy material without an explicitly saved plan', async t => {
  const root = mkdtempSync(join(tmpdir(), 'r01-assignment-operation-'));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contextDirectory = join(root, 'profile_A'); mkdirSync(contextDirectory, { mode: 0o700 });
  const source = JSON.stringify({ value: { vacancy_id: 'vacancy_A', test_task: 'legacy material' } });
  writeFileSync(join(contextDirectory, 'ats_config:vacancy_A.json'), source, { mode: 0o600 });
  const bindMaterial = createPrivateVacancyAssignmentMaterialBinding({ resolveProfileBinding: async profileId =>
    ({ profileId, contextDirectory }), isVacancyOwned: () => true });
  const result = await bindMaterial({ profileId: 'profile_A' }, { vacancyId: 'vacancy_A' });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: 'saved_assignment_plan_required' });
});
