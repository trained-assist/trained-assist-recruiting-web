import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createAcceptedReportSourceRead } from '../src/r04-accepted-report-source.js';
import { createRecruitingServer } from '../src/server.js';

const profileId = 'profile_demo_001';
const vacancyId = 'vac_demo_001';
const candidateId = 'candidate_demo_001';
const candidate = { id: candidateId, vacancyId, jobId: 'job_demo_001', firstName: 'Test', lastName: 'Person',
  title: 'Engineer', area: 'Synthetic region', totalExperienceMonths: 60,
  experience: [{ position: 'Developer', company: 'Example', start: '2020', end: null }],
  review: { status: 'starred', revision: 2 }, atsScore: 8, atsTag: 'PASS',
  comment: 'INTERNAL_ONLY', salary: { amount: 999999 }, hhUrl: 'https://hh.ru/resume/private' };
const acceptedCandidate = { id: candidateId, vacancyId, firstName: 'Test', lastName: 'Person', title: 'Engineer',
  area: 'Synthetic region', totalExperienceMonths: 60,
  experience: [{ position: 'Developer', company: 'Example', start: '2020', end: null }] };
const snapshot = { jobId: 'job_demo_001', resultRevision: 'snapshot-r1', criteriaRevision: 'criteria-r1' };
const ports = () => ({
  feed: { read: () => ({ resultRevision: 'feed-r1', items: [candidate] }) },
  candidateState: { latestSnapshot: () => snapshot, assessmentForLatest: () =>
    ({ kind: 'scored', candidate: acceptedCandidate,
      assessment: { atsScore: 8, atsTag: 'PASS', knockout: { status: 'passed', criteria: [] } } }) },
  loadBasePlan: async () => ({ profileId, vacancyId, criteriaRevision: 'criteria-r1',
    atsConfig: { vacancy_title: 'Senior Engineer', vacancy_context: 'SECRET_CONTEXT' } }),
  readResume: async (_context, { vacancyId: requestedVacancy, resumeId }) => ({ status: 200, body: {
    profileId, vacancyId: requestedVacancy, resumeId, sourceRevision: 'b'.repeat(64), criteriaRevision: 'criteria-r1',
    candidateProjection: structuredClone(acceptedCandidate),
    resume: { firstName: 'Test', lastName: 'Person', title: 'Engineer', experience: acceptedCandidate.experience,
      education: ['Synthetic university'], courses: ['Synthetic course'], skills: ['TypeScript'],
      languages: ['English — C1'], location: 'Synthetic region' }
  } }),
  isVacancyOwned: (id, vacancy) => id === profileId && vacancy === vacancyId
});

test('accepted current assessment gives only allowlisted proposal fields with revision', async () => {
  const read = createAcceptedReportSourceRead(ports());
  const result = await read({ profileId }, { vacancyId, candidateId });
  assert.equal(result.status, 200);
  assert.equal(result.body.clientDraftFields.candidateName, 'Test Person');
  assert.deepEqual(result.body.clientDraftFields.education, ['Synthetic university']);
  assert.deepEqual(result.body.clientDraftFields.courses, ['Synthetic course']);
  assert.deepEqual(result.body.clientDraftFields.skills, ['TypeScript']);
  assert.deepEqual(result.body.clientDraftFields.languages, ['English — C1']);
  assert.equal(result.body.clientDraftFields.location, 'Synthetic region');
  assert.equal(result.body.internalAssessment.atsScore, 8);
  assert.equal(result.body.publication, 'disabled');
  assert.equal(JSON.stringify(result.body).includes('INTERNAL_ONLY'), false);
  assert.equal(JSON.stringify(result.body).includes('SECRET_CONTEXT'), false);
  assert.equal(JSON.stringify(result.body).includes('999999'), false);
  const schema = JSON.parse(await readFile(new URL('../contracts/v1-accepted-report-source.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate(result.body), true, JSON.stringify(validate.errors));
  assert.equal((await read({ profileId: 'profile_demo_002' }, { vacancyId, candidateId })).status, 404);
  const changed = createAcceptedReportSourceRead({ ...ports(), feed: { read: () =>
    ({ resultRevision: 'feed-r2', items: [{ ...candidate, review: { status: 'starred', revision: 3 } }] }) } });
  assert.notEqual((await changed({ profileId }, { vacancyId, candidateId })).body.sourceRevision, result.body.sourceRevision);
});

test('cold-search report binds detailed HH resume to the accepted snapshot and rechecks its revision', async () => {
  const changing = ports();
  let reads = 0;
  changing.readResume = async (...args) => {
    const result = await ports().readResume(...args);
    result.body.sourceRevision = (++reads === 1 ? 'b' : 'c').repeat(64);
    return result;
  };
  assert.deepEqual(await createAcceptedReportSourceRead(changing)({ profileId }, { vacancyId, candidateId }),
    { status: 409, body: { error: 'candidate_source_stale' } });
  assert.equal(reads, 2);

  const mismatched = ports();
  mismatched.readResume = async (...args) => {
    const result = await ports().readResume(...args);
    result.body.candidateProjection.title = 'Changed resume title';
    return result;
  };
  assert.deepEqual(await createAcceptedReportSourceRead(mismatched)({ profileId }, { vacancyId, candidateId }),
    { status: 409, body: { error: 'candidate_source_stale' } });
});

test('archived, unscored, mismatched and stale candidates cannot become report sources', async () => {
  const archived = createAcceptedReportSourceRead({ ...ports(), feed: { read: () =>
    ({ resultRevision: 'feed-r1', items: [{ ...candidate, review: { status: 'archived', revision: 3 } }] }) } });
  assert.deepEqual(await archived({ profileId }, { vacancyId, candidateId }),
    { status: 409, body: { error: 'candidate_not_reportable' } });
  const unscoredPorts = ports();
  unscoredPorts.candidateState.assessmentForLatest = () => ({ kind: 'pending' });
  assert.deepEqual(await createAcceptedReportSourceRead(unscoredPorts)({ profileId }, { vacancyId, candidateId }),
    { status: 409, body: { error: 'candidate_assessment_incomplete' } });
  const stalePorts = ports();
  stalePorts.loadBasePlan = async () => ({ profileId, vacancyId, criteriaRevision: 'criteria-r2', atsConfig: { vacancy_title: 'Senior Engineer' } });
  assert.deepEqual(await createAcceptedReportSourceRead(stalePorts)({ profileId }, { vacancyId, candidateId }),
    { status: 409, body: { error: 'candidate_criteria_stale' } });
  const changedPorts = ports();
  let calls = 0;
  changedPorts.feed.read = () => ({ resultRevision: ++calls === 1 ? 'feed-r1' : 'feed-r2', items: [candidate] });
  assert.deepEqual(await createAcceptedReportSourceRead(changedPorts)({ profileId }, { vacancyId, candidateId }),
    { status: 409, body: { error: 'candidate_source_stale' } });
});

test('report source HTTP route requires trusted report scope and exact query', async t => {
  const server = createRecruitingServer({ acceptedReportSourceRead: createAcceptedReportSourceRead(ports()),
    resolveTrustedProfileContext: req => req.headers['x-test-principal'] === 'owner' ?
      { profileId, scopes: ['recruiting.reports.read'] } : req.headers['x-test-principal'] === 'noscope' ?
      { profileId, scopes: [] } : null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/ui/accepted-report-source?vacancyId=${vacancyId}&candidateId=${candidateId}`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { 'x-test-principal': 'noscope' } })).status, 403);
  assert.equal((await fetch(`${url}&profileId=${profileId}`, { headers: { 'x-test-principal': 'owner' } })).status, 400);
  const accepted = await fetch(url, { headers: { 'x-test-principal': 'owner' } });
  assert.equal(accepted.status, 200, await accepted.text());
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-test-principal': 'owner' } })).status, 405);
});
