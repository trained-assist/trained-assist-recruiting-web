import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mapHhResumeCandidate, mapHhResumePage, normalizeHhAtsConfig } from '../src/hh-resume-mapping.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/hh-resumes-invented.json', import.meta.url), 'utf8'));

test('invented HH response maps to canonical candidate and preserves legacy weighted pre-score', () => {
  assert.equal(fixture.invented, true);
  const original = structuredClone(fixture);
  const mapped = mapHhResumePage(fixture.items, fixture.atsConfig, fixture.vacancyId);
  assert.deepEqual(fixture, original, 'pure mapping must not mutate provider or ATS data');
  assert.equal(mapped.totalCollected, 3);
  assert.equal(mapped.totalAfterMinExperience, 2);
  assert.deepEqual(mapped.excluded.map(item => [item.resumeId, item.reason]), [['syntheticresume003', 'min_experience']]);
  assert.deepEqual(mapped.candidates.map(item => item.id), ['syntheticresume001', 'syntheticresume002']);
  const [first, second] = mapped.candidates;
  assert.equal(first.preScore, 7.5);
  assert.equal(first.totalPossible, 7.5);
  assert.equal(first.preTag, 'PASS');
  assert.deepEqual(first.preScoreSignals, ['опыт 5л +1.5', 'проектирование машин +3', 'чертежи CAD +2', 'испытания прототипов +1']);
  assert.equal(first.totalExperienceYears, 5.1);
  assert.equal(first.firstName, 'Вымышленная');
  assert.equal(first.recentCompanies[0], 'Вымышленное бюро');
  assert.equal(first.experience[0].description, undefined, 'legacy display projection does not include raw description');
  assert.deepEqual(first.knockout, { status: 'pending_ai', criteria: ['нет профильного опыта'] });
  assert.equal(first.atsScore, null);
  assert.equal(first.atsTag, null);
  assert.equal(second.preScore, 1.5, 'generic words such as опыт/работы do not match criteria');
  assert.equal(second.preTag, 'WEAK');
  assert.equal(second.hhUrl, 'https://hh.ru/resume/syntheticresume002', 'untrusted alternate URL is replaced');
});

test('ATS normalization accepts historical editor/LLM field names and double-serialized config', () => {
  const config = normalizeHhAtsConfig(JSON.stringify(fixture.atsConfig));
  assert.equal(config.minExperienceYears, 2);
  assert.deepEqual(config.required, [{ name: 'проектирование машин', weight: 3 }, { name: 'чертежи CAD', weight: 2 }]);
  assert.deepEqual(config.knockout, ['нет профильного опыта']);
  const modern = normalizeHhAtsConfig({ title: 'Синтетическая вакансия', filters: { min_experience_years: 6 }, required: [{ name: 'анализ данных', weight: 2 }], preferred: [] });
  assert.equal(modern.minExperienceYears, 6);
  assert.equal(modern.vacancyTitle, 'Синтетическая вакансия');
  assert.equal(normalizeHhAtsConfig({ filters: { min_experience_years: 0 } }).minExperienceYears, 0);
  assert.throws(() => normalizeHhAtsConfig('{broken'), /invalid_ats_config/);
  assert.throws(() => normalizeHhAtsConfig({ required: [{ name: 'bad', weight: -1 }] }), /invalid_ats_weight/);
});

test('minimum experience is the only deterministic knockout; arbitrary ATS knockout remains pending AI', () => {
  const config = { filters: { min_experience_years: 1 }, required: [], knockout: ['нет профильного образования'] };
  const accepted = mapHhResumeCandidate({ id: 'syntheticresume004', title: 'Неизвестная специальность', total_experience: { months: 12 }, experience: [] }, config, fixture.vacancyId);
  assert.equal(accepted.kind, 'candidate');
  assert.equal(accepted.candidate.knockout.status, 'pending_ai');
  assert.equal(accepted.candidate.preTag, 'PASS', 'pre-tag is only a prioritization hint, not final ATS verdict');
  const excluded = mapHhResumeCandidate({ id: 'syntheticresume005', title: 'Инженер', total_experience: { months: 11 }, experience: [] }, config, fixture.vacancyId);
  assert.equal(excluded.kind, 'excluded');
  assert.equal(excluded.reason, 'min_experience');
});

test('bad provider shapes fail without logging names or attempting state writes', () => {
  const privateName = 'PRIVATE_CANDIDATE_NAME';
  const logs = [];
  const original = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...parts) => logs.push(parts.join(' '));
  try {
    assert.throws(() => mapHhResumePage(Array(51).fill(fixture.items[0]), fixture.atsConfig, fixture.vacancyId), /invalid_hh_page/);
    assert.throws(() => mapHhResumeCandidate({ id: '../bad', title: privateName, experience: [] }, fixture.atsConfig, fixture.vacancyId), /invalid_hh_resume/);
    assert.throws(() => mapHhResumeCandidate({ id: 'syntheticresume006', title: privateName, total_experience: { months: -1 }, experience: [] }, fixture.atsConfig, fixture.vacancyId), /invalid_hh_resume/);
    assert.deepEqual(logs, []);
  } finally { [console.log, console.warn, console.error] = original; }
});
