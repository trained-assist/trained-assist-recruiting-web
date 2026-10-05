import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createRecruitingServer } from '../src/server.js';
import { evaluateSyntheticResponse } from '../src/response-evaluation.js';
import { syntheticColdSearchProvider } from '../src/candidate-search-jobs.js';

const root = new URL('../', import.meta.url);
let server;
let base;
test.before(async () => {
  server = createRecruitingServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

async function get(path) { return fetch(`${base}${path}`); }
async function loadSchema(name) {
  return JSON.parse(await readFile(new URL(`contracts/${name}`, root), 'utf8'));
}

test('manifest, capabilities, and readiness expose a versioned read-only contract', async () => {
  const manifest = await (await get('/api/v1/manifest')).json();
  const schema = await loadSchema('v1-manifest.schema.json');
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(manifest.serviceId, 'trained-assist.recruiting');
  assert.equal(manifest.release.environment, 'local');
  assert.equal(manifest.readiness.status, 'ready');
  assert.match(manifest.readiness.reason.message, /local synthetic-fixture use only/);
  assert.deepEqual(manifest.capabilities[0], {
    id: 'recruiting.vacancies.list',
    version: '1.0.0',
    required: true,
    inputSchemaRef: 'contracts/v1-vacancies-query.schema.json',
    outputSchemaRef: 'contracts/v1-vacancies.schema.json',
    effect: 'read',
    requiredScopes: [],
    operationRef: 'GET /api/v1/vacancies'
  });
  assert.deepEqual(schema.properties.readiness.properties.status.enum, ['ready', 'degraded', 'blocked', 'unavailable']);
  assert.deepEqual(manifest.capabilities.map(({ id }) => id), ['recruiting.vacancies.list']);
  assert.deepEqual(Object.keys(manifest.endpoints), ['manifest', 'capabilities', 'readiness', 'vacancies']);
  const capabilities = await (await get('/api/v1/capabilities')).json();
  assert.deepEqual(capabilities.capabilities, manifest.capabilities);
  const readiness = await (await get('/api/v1/readiness')).json();
  assert.equal(readiness.status, 'ready');
  assert.deepEqual(readiness.checkedVersionTuple, manifest.readiness.checkedVersionTuple);
  assert.equal((await get('/health/ready')).status, 200);
  const invalidManifest = { ...manifest, platformContractRange: '*' };
  assert.equal(validate(invalidManifest), false);
});

test('vacancies match the published schema and contain synthetic data only', async () => {
  const response = await get('/api/v1/vacancies');
  const payload = await response.json();
  const schema = await loadSchema('v1-vacancies.schema.json');
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  assert.equal(response.status, 200);
  assert.equal(validate(payload), true, JSON.stringify(validate.errors));
  assert.ok(payload.items.length > 0);
  assert.equal(validate({ ...payload, items: [{ ...payload.items[0], candidateEmail: 'person@example.com' }] }), false);
  const queryResponse = await get('/api/v1/vacancies?unexpected=value');
  assert.equal(queryResponse.status, 400);
  assert.deepEqual(await queryResponse.json(), { error: 'unexpected_query_parameters' });
});

test('local UI fixture routes enforce synthetic profile checks and paginate revision-bound response reads', async () => {
  const profileId = 'profile_demo_001';
  const vacancyId = 'vac_demo_001';
  const vacanciesInput = await loadSchema('v1-profile-vacancies-input.schema.json');
  const vacanciesOutput = await loadSchema('v1-profile-vacancies.schema.json');
  const responsesInput = await loadSchema('v1-vacancy-responses-input.schema.json');
  const responsesOutput = await loadSchema('v1-vacancy-responses.schema.json');
  const ajv = new Ajv2020({ allErrors: true });
  const validateVacanciesInput = ajv.compile(vacanciesInput);
  const validateVacanciesOutput = ajv.compile(vacanciesOutput);
  const validateResponsesInput = ajv.compile(responsesInput);
  const validateResponsesOutput = ajv.compile(responsesOutput);

  assert.equal(validateVacanciesInput({ profileId }), true);
  assert.equal(validateResponsesInput({ profileId, vacancyId }), true);
  assert.equal(validateResponsesInput({ profileId, vacancyId, limit: 1 }), true);
  assert.equal(validateResponsesInput({ profileId, vacancyId, applicantEmail: 'person@example.com' }), false);

  const url = `/api/v1/profiles/${profileId}/vacancies`;
  assert.equal((await get(url)).status, 401);
  assert.equal((await fetch(`${base}${url}`, { headers: { 'X-Demo-Profile-Id': 'profile_demo_002' } })).status, 403);

  const vacanciesResponse = await fetch(`${base}${url}`, { headers: { 'X-Demo-Profile-Id': profileId } });
  const vacanciesPayload = await vacanciesResponse.json();
  assert.equal(vacanciesResponse.status, 200);
  assert.equal(validateVacanciesOutput(vacanciesPayload), true, JSON.stringify(validateVacanciesOutput.errors));
  assert.deepEqual(vacanciesPayload.items.map(item => item.id), [vacancyId]);

  const responsesUrl = `/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?limit=1`;
  const responsesResponse = await fetch(`${base}${responsesUrl}`, { headers: { 'X-Demo-Profile-Id': profileId } });
  const responsesPayload = await responsesResponse.json();
  assert.equal(responsesResponse.status, 200);
  assert.equal(validateResponsesOutput(responsesPayload), true, JSON.stringify(validateResponsesOutput.errors));
  assert.equal(responsesPayload.freshness, 'current');
  assert.equal(responsesPayload.revision, 'responses-demo-001-r1');
  assert.equal(responsesPayload.items.length, 1);
  assert.ok(responsesPayload.nextCursor);
  assert.equal(validateResponsesInput({ profileId, vacancyId, limit: 1, cursor: responsesPayload.nextCursor }), true);

  const nextPageUrl = `/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?limit=1&cursor=${encodeURIComponent(responsesPayload.nextCursor)}`;
  const nextPageResponse = await fetch(`${base}${nextPageUrl}`, { headers: { 'X-Demo-Profile-Id': profileId } });
  const nextPagePayload = await nextPageResponse.json();
  assert.equal(nextPageResponse.status, 200);
  assert.equal(validateResponsesOutput(nextPagePayload), true, JSON.stringify(validateResponsesOutput.errors));
  assert.equal(nextPagePayload.revision, responsesPayload.revision);
  assert.equal(nextPagePayload.freshness, 'current');
  assert.equal(nextPagePayload.items[0].id, 'response_demo_002');
  assert.equal(nextPagePayload.nextCursor, null);

  const staleCursor = Buffer.from(JSON.stringify({ profileId, vacancyId, revision: 'responses-demo-001-r0', offset: 1 })).toString('base64url');
  const staleResponse = await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?cursor=${staleCursor}`, { headers: { 'X-Demo-Profile-Id': profileId } });
  const stalePayload = await staleResponse.json();
  assert.equal(staleResponse.status, 409);
  assert.equal(validateResponsesOutput(stalePayload), true, JSON.stringify(validateResponsesOutput.errors));
  assert.equal(stalePayload.freshness, 'stale');
  assert.equal(stalePayload.currentRevision, responsesPayload.revision);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?limit=0`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?cursor=`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?cursor=%%%`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses?unexpected=x`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/${vacancyId}/responses`, { method: 'POST', headers: { 'X-Demo-Profile-Id': profileId } })).status, 405);
  assert.equal((await fetch(`${base}/api/v1/profiles/${profileId}/vacancies/vac_demo_002/responses`, { headers: { 'X-Demo-Profile-Id': profileId } })).status, 404);
  const insufficientScope = await fetch(`${base}/api/v1/profiles/profile_demo_002/vacancies/vac_demo_002/responses`, { headers: { 'X-Demo-Profile-Id': 'profile_demo_002' } });
  assert.equal(insufficientScope.status, 403);
  assert.deepEqual(await insufficientScope.json(), { error: 'demo_scope_required' });
});

test('client report preview is synthetic, audience-scoped, escaped, pair-checked, and never publishes', async () => {
  const sources = JSON.parse(await readFile(new URL('data/report-scenarios.json', root), 'utf8'));
  const sourceSchema = await loadSchema('v1-report-source-internal.schema.json');
  const querySchema = await loadSchema('v1-report-preview-query.schema.json');
  const previewSchema = await loadSchema('v1-client-report-preview.schema.json');
  const ajv = new Ajv2020({ allErrors: true });
  const validateSource = ajv.compile(sourceSchema);
  const validateQuery = ajv.compile(querySchema);
  const validatePreview = ajv.compile(previewSchema);
  const source = sources[0];
  const query = { candidateId: source.candidateId, vacancyId: source.vacancyId };
  assert.equal(validateSource(source), true, JSON.stringify(validateSource.errors));
  assert.equal(validateQuery(query), true);
  assert.equal(validateQuery({ ...query, audience: 'internal' }), false);
  assert.equal(validateSource({ ...source, audience: 'client' }), false);

  const fixtureBefore = await readFile(new URL('data/report-scenarios.json', root));
  const previewUrl = `/api/v1/ui/report-previews?candidateId=${query.candidateId}&vacancyId=${query.vacancyId}`;
  const response = await get(previewUrl);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(validatePreview(payload), true, JSON.stringify(validatePreview.errors));
  assert.equal(payload.mode, 'preview');
  assert.equal(payload.audience, 'client');
  assert.equal(payload.previewOnly, true);
  assert.equal(payload.publication, 'disabled');
  assert.equal(payload.sourceRevision, source.sourceRevision);
  assert.equal(validatePreview({ ...payload, clientView: { ...payload.clientView, internalNotes: 'not allowed' } }), false);
  assert.match(payload.html, new RegExp(`report-source-revision" content="${source.sourceRevision}`));
  assert.match(payload.html, /СИНТЕТИЧЕСКИЙ ЧЕРНОВИК · НЕ ДЛЯ ОТПРАВКИ/);
  assert.match(payload.html, /&lt;script&gt;alert\(&quot;synthetic&quot;\)&lt;\/script&gt; &amp; reliable APIs\./);
  assert.equal(payload.html.includes('<script>alert("synthetic")</script>'), false);
  const internalMarkers = Object.values(source.internal).flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value : []);
  for (const marker of internalMarkers) {
    assert.equal(payload.html.includes(marker), false, `internal marker leaked: ${marker}`);
    assert.equal(JSON.stringify(payload.clientView).includes(marker), false, `internal marker leaked into client view: ${marker}`);
  }
  assert.equal(Object.hasOwn(payload, 'internal'), false);
  assert.equal((await (await get(previewUrl)).json()).html, payload.html, 'renderer output is deterministic');

  const mismatch = await get(`/api/v1/ui/report-previews?candidateId=${query.candidateId}&vacancyId=vac_demo_002`);
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await mismatch.json(), { error: 'candidate_vacancy_mismatch' });
  assert.equal((await get('/api/v1/ui/report-previews?candidateId=candidate_demo_999&vacancyId=vac_demo_001')).status, 404);
  assert.equal((await get('/api/v1/ui/report-previews?candidateId=candidate_demo_001&vacancyId=vac_demo_001&audience=internal')).status, 400);
  assert.equal((await fetch(`${base}${previewUrl}`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/v1/ui/report-publish`, { method: 'POST' })).status, 405);
  assert.equal((await get('/api/v1/ui/report-publish')).status, 404);
  assert.deepEqual(await readFile(new URL('data/report-scenarios.json', root)), fixtureBefore);
});

test('R-04 synthetic report draft lifecycle enforces client fields, review, publication policy, source revision, and revoke', async () => {
  const startSchema = await loadSchema('v1-report-draft-start.schema.json');
  const editSchema = await loadSchema('v1-report-client-edit.schema.json');
  const reviewSchema = await loadSchema('v1-report-review.schema.json');
  const actionSchema = await loadSchema('v1-report-action.schema.json');
  const draftSchema = await loadSchema('v1-report-draft.schema.json');
  const previewSchema = await loadSchema('v1-report-lifecycle-preview.schema.json');
  const clientPreviewSchema = await loadSchema('v1-client-report-preview.schema.json');
  const source = JSON.parse(await readFile(new URL('data/report-scenarios.json', root), 'utf8'))[0];
  const sourceBefore = await readFile(new URL('data/report-scenarios.json', root));
  const ajv = new Ajv2020({ allErrors: true });
  ajv.addSchema(clientPreviewSchema);
  const validateStart = ajv.compile(startSchema);
  const validateEdit = ajv.compile(editSchema);
  const validateReview = ajv.compile(reviewSchema);
  const validateAction = ajv.compile(actionSchema);
  const validateDraft = ajv.compile(draftSchema);
  const validatePreview = ajv.compile(previewSchema);
  const startRequest = { candidateId: source.candidateId, vacancyId: source.vacancyId, expectedSourceRevision: source.sourceRevision };
  const editRequest = { expectedReportRevision: 'report-demo-r1', clientFields: { summary: '<img src=x onerror="synthetic"> & safe text', conclusion: 'Synthetic edited conclusion.' } };
  assert.equal(validateStart(startRequest), true);
  assert.equal(validateStart({ ...startRequest, profileId: 'profile_demo_001' }), false);
  assert.equal(validateEdit(editRequest), true);
  assert.equal(validateEdit({ ...editRequest, clientFields: { ...editRequest.clientFields, internalScore: 10 } }), false);
  assert.equal(validateReview({ expectedReportRevision: 'report-demo-r1', decision: 'approved' }), true);
  assert.equal(validateReview({ expectedReportRevision: 'report-demo-r1', decision: 'publish' }), false);
  assert.equal(validateAction({ expectedReportRevision: 'report-demo-r1' }), true);

  const scopes = {
    profile_demo_001: ['recruiting.reports.create', 'recruiting.reports.read', 'recruiting.reports.edit', 'recruiting.reports.review', 'recruiting.reports.publish', 'recruiting.reports.revoke'],
    profile_demo_002: ['recruiting.reports.create', 'recruiting.reports.read', 'recruiting.reports.edit', 'recruiting.reports.review', 'recruiting.reports.publish', 'recruiting.reports.revoke'],
    profile_demo_003: ['recruiting.reports.create', 'recruiting.reports.read', 'recruiting.reports.edit', 'recruiting.reports.revoke']
  };
  const resolveReportTestContext = req => {
    const principal = req.headers['x-test-principal'];
    if (principal === 'profile_demo_001_no_review') return { profileId: 'profile_demo_001', scopes: scopes.profile_demo_003 };
    if (principal === 'profile_demo_001_no_revoke') return { profileId: 'profile_demo_001', scopes: scopes.profile_demo_003.filter(scope => scope !== 'recruiting.reports.revoke') };
    return scopes[principal] ? { profileId: principal, scopes: scopes[principal] } : null;
  };
  let currentSourceRevision = source.sourceRevision;
  const noPolicyServer = createRecruitingServer({
    resolveTrustedProfileContext: resolveReportTestContext,
    resolveCurrentReportSourceRevision: () => currentSourceRevision
  });
  await new Promise(resolve => noPolicyServer.listen(0, '127.0.0.1', resolve));
  const noPolicyBase = `http://127.0.0.1:${noPolicyServer.address().port}/api/v1/ui/report-drafts`;
  const jsonHeaders = principal => ({ 'X-Test-Principal': principal, 'Content-Type': 'application/json' });
  const createDraft = (base, body = startRequest, key = 'r04-report-draft-1', principal = 'profile_demo_001') => fetch(base, { method: 'POST', headers: { ...jsonHeaders(principal), 'Idempotency-Key': key }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(noPolicyBase, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'r04-no-principal' }, body: JSON.stringify(startRequest) })).status, 401);
    assert.equal((await createDraft(noPolicyBase, { ...startRequest, vacancyId: 'vac_demo_002' }, 'r04-wrong-pair')).status, 409);
    assert.equal((await createDraft(noPolicyBase, { ...startRequest, candidateId: 'candidate_demo_999' }, 'r04-missing-candidate')).status, 404);
    assert.equal((await createDraft(noPolicyBase, { ...startRequest, expectedSourceRevision: 'synthetic-candidate-demo-001-r0' }, 'r04-stale-source')).status, 409);

    const createdResponse = await createDraft(noPolicyBase);
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201);
    assert.equal(validateDraft(created), true, JSON.stringify(validateDraft.errors));
    assert.equal(created.status, 'draft');
    assert.equal(created.reviewState, 'unreviewed');
    assert.equal(created.publicationReceipt, null);
    assert.equal((await (await createDraft(noPolicyBase)).json()).reportRef, created.reportRef, 'repeated create returns the stable report reference');

    const reportUrl = `${noPolicyBase}/${created.reportRef}`;
    assert.equal((await fetch(reportUrl, { headers: { 'X-Test-Principal': 'profile_demo_002' } })).status, 404, 'report refs are profile scoped');
    const otherScope = await fetch(`${reportUrl}/review`, { method: 'POST', headers: jsonHeaders('profile_demo_003'), body: JSON.stringify({ expectedReportRevision: created.reportRevision, decision: 'approved' }) });
    assert.equal(otherScope.status, 404);
    const noReviewScope = await fetch(`${reportUrl}/review`, { method: 'POST', headers: jsonHeaders('profile_demo_001_no_review'), body: JSON.stringify({ expectedReportRevision: created.reportRevision, decision: 'approved' }) });
    assert.equal(noReviewScope.status, 403);

    const invalidEdit = await fetch(reportUrl, { method: 'PATCH', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify({ expectedReportRevision: created.reportRevision, clientFields: { internalScore: 99 } }) });
    assert.equal(invalidEdit.status, 400);
    const editedResponse = await fetch(reportUrl, { method: 'PATCH', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify(editRequest) });
    const edited = await editedResponse.json();
    assert.equal(editedResponse.status, 200);
    assert.equal(validateDraft(edited), true, JSON.stringify(validateDraft.errors));
    assert.equal(edited.reportRevision, 'report-demo-r2');
    assert.equal(edited.reviewState, 'unreviewed');
    assert.equal(edited.clientFields.summary, editRequest.clientFields.summary);
    for (const marker of Object.values(source.internal).flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])) {
      assert.equal(JSON.stringify(edited).includes(marker), false, `internal source leaked in draft state: ${marker}`);
    }
    const staleEdit = await fetch(reportUrl, { method: 'PATCH', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify({ ...editRequest, expectedReportRevision: created.reportRevision }) });
    assert.equal(staleEdit.status, 409);
    const previewResponse = await fetch(`${reportUrl}/preview`, { headers: { 'X-Test-Principal': 'profile_demo_001' } });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.equal(validatePreview(preview), true, JSON.stringify(validatePreview.errors));
    assert.equal(preview.reportRef, created.reportRef);
    assert.equal(preview.reportRevision, edited.reportRevision);
    assert.equal(preview.publication, 'not_shared');
    assert.match(preview.html, /&lt;img src=x onerror=&quot;synthetic&quot;&gt; &amp; safe text/);
    assert.equal(preview.html.includes('<img src=x onerror="synthetic">'), false);
    for (const marker of Object.values(source.internal).flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])) {
      assert.equal(JSON.stringify(preview).includes(marker), false, `internal source leaked in preview: ${marker}`);
    }

    currentSourceRevision = 'synthetic-candidate-demo-001-r2';
    assert.equal((await fetch(`${reportUrl}/preview`, { headers: { 'X-Test-Principal': 'profile_demo_001' } })).status, 409, 'preview rejects changed source revision');
    currentSourceRevision = source.sourceRevision;
    const unreviewedPublish = await fetch(`${reportUrl}/publish`, { method: 'POST', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify({ expectedReportRevision: edited.reportRevision }) });
    assert.equal(unreviewedPublish.status, 409);
    assert.equal((await unreviewedPublish.json()).error, 'report_review_required');

    const reviewedResponse = await fetch(`${reportUrl}/review`, { method: 'POST', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify({ expectedReportRevision: edited.reportRevision, decision: 'approved' }) });
    const reviewed = await reviewedResponse.json();
    assert.equal(reviewedResponse.status, 200);
    assert.equal(reviewed.reviewState, 'approved');
    assert.equal(reviewed.reportRevision, 'report-demo-r3');
    const deniedPublish = await fetch(`${reportUrl}/publish`, { method: 'POST', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify({ expectedReportRevision: reviewed.reportRevision }) });
    assert.equal(deniedPublish.status, 403, 'missing policy adapter denies publication');
    const stillDraft = await (await fetch(reportUrl, { headers: { 'X-Test-Principal': 'profile_demo_001' } })).json();
    assert.equal(stillDraft.status, 'draft');
    assert.equal(stillDraft.reviewState, 'approved');
    assert.equal(stillDraft.reportRevision, reviewed.reportRevision, 'denied publication does not mutate draft state');
  } finally { await new Promise(resolve => noPolicyServer.close(resolve)); }

  let publishAttempts = 0;
  let adapterPublishCalls = 0;
  let adapterRevokeCalls = 0;
  const publicationAdapter = {
    async publish(input) {
      adapterPublishCalls++;
      assert.equal(input.audience, 'client');
      assert.equal(Object.hasOwn(input, 'internal'), false);
      for (const marker of Object.values(source.internal).flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])) {
        assert.equal(JSON.stringify(input).includes(marker), false, `internal source leaked to publication adapter: ${marker}`);
      }
      publishAttempts++;
      if (publishAttempts === 1) throw new Error('private policy/provider diagnostic');
      return { allowed: true, receiptId: 'publication_demo_abcdef123456' };
    },
    async revoke(input) { adapterRevokeCalls++; assert.equal(input.receiptId, 'publication_demo_abcdef123456'); return { allowed: true }; }
  };
  const authorizedServer = createRecruitingServer({
    resolveTrustedProfileContext: resolveReportTestContext,
    resolveCurrentReportSourceRevision: () => source.sourceRevision,
    publicationAdapter
  });
  await new Promise(resolve => authorizedServer.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${authorizedServer.address().port}/api/v1/ui/report-drafts`;
    const createdResponse = await createDraft(base, startRequest, 'r04-authorized-publish');
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201);
    const reportUrl = `${base}/${created.reportRef}`;
    const unreviewedPublish = await fetch(`${reportUrl}/publish`, { method: 'POST', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify({ expectedReportRevision: created.reportRevision }) });
    assert.equal(unreviewedPublish.status, 409);
    assert.equal(adapterPublishCalls, 0, 'unreviewed drafts never invoke publication policy/adapter');
    const reviewedResponse = await fetch(`${reportUrl}/review`, { method: 'POST', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify({ expectedReportRevision: created.reportRevision, decision: 'approved' }) });
    const reviewed = await reviewedResponse.json();
    const publishAction = { expectedReportRevision: reviewed.reportRevision };
    const failedPublish = await fetch(`${reportUrl}/publish`, { method: 'POST', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify(publishAction) });
    assert.equal(failedPublish.status, 503);
    assert.deepEqual((await failedPublish.json()).error, 'publication_unavailable');
    const keptDraft = await (await fetch(reportUrl, { headers: { 'X-Test-Principal': 'profile_demo_001' } })).json();
    assert.equal(keptDraft.status, 'draft');
    assert.equal(keptDraft.reviewState, 'approved');
    assert.equal(keptDraft.reportRevision, reviewed.reportRevision, 'publication failure keeps approved draft intact');

    const successResponse = await fetch(`${reportUrl}/publish`, { method: 'POST', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify(publishAction) });
    const published = await successResponse.json();
    assert.equal(successResponse.status, 200);
    assert.equal(validateDraft(published), true, JSON.stringify(validateDraft.errors));
    assert.equal(published.status, 'published');
    assert.equal(published.reportRef, created.reportRef);
    assert.equal(published.publicationReceipt, 'publication_demo_abcdef123456');
    assert.equal(adapterPublishCalls, 2);
    assert.equal((await fetch(reportUrl, { headers: { 'X-Test-Principal': 'profile_demo_002' } })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${authorizedServer.address().port}/api/v1/reports/${created.reportRef}`)).status, 404, 'there is no public sharing endpoint');
    const noRevokeScope = await fetch(`${reportUrl}/revoke`, { method: 'POST', headers: jsonHeaders('profile_demo_001_no_revoke'), body: JSON.stringify({ expectedReportRevision: published.reportRevision }) });
    assert.equal(noRevokeScope.status, 403);
    const revokedResponse = await fetch(`${reportUrl}/revoke`, { method: 'POST', headers: jsonHeaders('profile_demo_001'), body: JSON.stringify({ expectedReportRevision: published.reportRevision }) });
    const revoked = await revokedResponse.json();
    assert.equal(revokedResponse.status, 200);
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.reportRef, created.reportRef);
    assert.equal(adapterRevokeCalls, 1);
    assert.equal((await fetch(`${reportUrl}/preview`, { headers: { 'X-Test-Principal': 'profile_demo_001' } })).status, 410, 'revoked report access is denied');
  } finally { await new Promise(resolve => authorizedServer.close(resolve)); }

  assert.equal((await (await get('/api/v1/capabilities')).json()).capabilities.some(item => item.id.includes('report')), false, 'report lifecycle is not advertised as a platform capability');
  assert.deepEqual(await readFile(new URL('data/report-scenarios.json', root)), sourceBefore, 'draft lifecycle never mutates source fixture');
});

test('R-02 synthetic evaluation is profile scoped, revision pinned, typed, deterministic, and side-effect free', async () => {
  const inputSchema = await loadSchema('v1-response-evaluation-input.schema.json');
  const evaluatorSchema = await loadSchema('v1-evaluator-result.schema.json');
  const outputSchema = await loadSchema('v1-response-evaluation.schema.json');
  const sourceSchema = await loadSchema('v1-response-evaluation-source.schema.json');
  const fixture = JSON.parse(await readFile(new URL('data/response-evaluation-scenarios.json', root), 'utf8'))[0];
  const ajv = new Ajv2020({ allErrors: true });
  ajv.addSchema(evaluatorSchema);
  const validateInput = ajv.compile(inputSchema);
  const validateOutput = ajv.compile(outputSchema);
  const validateSource = ajv.compile(sourceSchema);
  const input = { responseId: fixture.responseId, vacancyId: fixture.vacancyId, expectedResponseRevision: fixture.responseRevision, expectedResumeRevision: fixture.resumeRevision, expectedCriteriaRevision: fixture.criteriaRevision };
  assert.equal(validateInput(input), true);
  assert.equal(validateSource(fixture), true, JSON.stringify(validateSource.errors));
  assert.equal(validateInput({ ...input, profileId: fixture.profileId }), false, 'profile is never model supplied');
  assert.equal(validateInput({ ...input, extra: true }), false);
  assert.equal(validateOutput({}), false);

  const fixturePath = new URL('data/response-evaluation-scenarios.json', root);
  const before = await readFile(fixturePath);
  let calls = 0;
  const trustedServer = createRecruitingServer({
    resolveTrustedProfileContext: req => ['profile_demo_001', 'profile_demo_002', 'profile_demo_003'].includes(req.headers['x-test-principal']) ? { profileId: req.headers['x-test-principal'], scopes: req.headers['x-test-principal'] === 'profile_demo_003' ? [] : ['recruiting.responses.evaluate'] } : null,
    evaluator: args => { calls++; return evaluateSyntheticResponse(args); }
  });
  await new Promise(resolve => trustedServer.listen(0, '127.0.0.1', resolve));
  const trustedBase = `http://127.0.0.1:${trustedServer.address().port}`;
  const urlFor = values => `/api/v1/ui/response-evaluations?${new URLSearchParams(values)}`;
  const request = (values, principal = fixture.profileId) => fetch(`${trustedBase}${urlFor(values)}`, { headers: { 'X-Test-Principal': principal } });
  try {
    assert.equal((await get(urlFor(input))).status, 401, 'default resolver denies profile route');
    const successResponse = await request(input);
    const payload = await successResponse.json();
    assert.equal(successResponse.status, 200);
    assert.equal(validateOutput(payload), true, JSON.stringify(validateOutput.errors));
    assert.equal(payload.result, 'meets');
    assert.equal(payload.evidence.length, 2);
    assert.equal(payload.gaps.length, 1);
    assert.deepEqual(payload.sourceRevisions, { response: fixture.responseRevision, resume: fixture.resumeRevision, vacancyCriteria: fixture.criteriaRevision });
    assert.deepEqual(await (await request(input)).json(), payload, 'evaluation output and ID are deterministic');
    assert.equal(calls, 2);

    assert.equal((await request({ ...input, vacancyId: 'vac_demo_002' })).status, 409);
    assert.equal((await request(input, 'profile_demo_002')).status, 404, 'cross-profile requests do not reveal the fixture');
    assert.equal((await request(input, 'profile_demo_003')).status, 403);
    for (const [field, stale] of [['expectedResponseRevision', 'response-demo-001-r0'], ['expectedResumeRevision', 'resume-demo-001-r0'], ['expectedCriteriaRevision', 'criteria-vac-demo-001-r0']]) {
      const response = await request({ ...input, [field]: stale });
      const body = await response.json();
      assert.equal(response.status, 409);
      assert.equal(validateOutput(body), true, JSON.stringify(validateOutput.errors));
      assert.ok(body.staleRevisions.length);
    }
    assert.equal(calls, 2, 'stale sources never reach the evaluator');

    const inconsistentOutputs = [
      { result: 'meets', evidence: [], gaps: fixture.criteria.map(item => ({ criterionId: item.id, kind: 'missing_evidence', required: item.required, reason: 'Synthetic missing evidence.' })) },
      { result: 'meets', evidence: fixture.criteria.filter(item => item.id !== 'database-operations').map(item => ({ criterionId: item.id, source: 'resume', excerpt: 'Synthetic evidence.' })), gaps: [{ criterionId: 'database-operations', kind: 'missing_evidence', required: true, reason: 'Synthetic missing evidence.' }] }
    ];
    for (const malformedOutput of [{ result: 'publish', evidence: [], gaps: [], sideEffect: true }, ...inconsistentOutputs]) {
      if (inconsistentOutputs.includes(malformedOutput)) assert.equal(ajv.validate(evaluatorSchema, malformedOutput), true, 'inconsistent fixture output remains structurally schema-valid');
      const invalidServer = createRecruitingServer({ resolveTrustedProfileContext: () => ({ profileId: fixture.profileId, scopes: ['recruiting.responses.evaluate'] }), evaluator: () => malformedOutput });
      await new Promise(resolve => invalidServer.listen(0, '127.0.0.1', resolve));
      try {
        const invalid = await fetch(`http://127.0.0.1:${invalidServer.address().port}${urlFor(input)}`);
        assert.equal(invalid.status, 502);
        assert.deepEqual(await invalid.json(), { error: 'invalid_evaluator_output' });
      } finally { await new Promise(resolve => invalidServer.close(resolve)); }
    }
    for (const failingAdapter of [
      () => { throw new Error('synthetic private diagnostic'); },
      async () => { throw new Error('synthetic private diagnostic'); }
    ]) {
      const failingServer = createRecruitingServer({ resolveTrustedProfileContext: () => ({ profileId: fixture.profileId, scopes: ['recruiting.responses.evaluate'] }), evaluator: failingAdapter });
      await new Promise(resolve => failingServer.listen(0, '127.0.0.1', resolve));
      try {
        const failure = await fetch(`http://127.0.0.1:${failingServer.address().port}${urlFor(input)}`);
        assert.equal(failure.status, 503);
        const failureBody = await failure.json();
        assert.deepEqual(failureBody, { error: 'evaluator_unavailable' });
        assert.equal(JSON.stringify(failureBody).includes('synthetic private diagnostic'), false);
      } finally { await new Promise(resolve => failingServer.close(resolve)); }
    }

    assert.equal((await fetch(`${trustedBase}${urlFor(input)}`, { method: 'POST' })).status, 405);
    assert.equal((await (await fetch(`${base}/api/v1/capabilities`)).json()).capabilities.some(item => item.id.includes('response')), false);
    assert.deepEqual(await readFile(fixturePath), before, 'evaluation does not mutate source fixtures');
  } finally { await new Promise(resolve => trustedServer.close(resolve)); }
});

test('R-03 synthetic search jobs are idempotent, profile bound, resumable, revision checked, and paginated', async () => {
  const inputSchema = await loadSchema('v1-candidate-search-start.schema.json');
  const jobSchema = await loadSchema('v1-candidate-search-job.schema.json');
  const resultsSchema = await loadSchema('v1-candidate-search-results.schema.json');
  const fixtureBefore = await readFile(new URL('data/cold-search-results.json', root));
  const ajv = new Ajv2020({ allErrors: true });
  const validateInput = ajv.compile(inputSchema);
  const validateJob = ajv.compile(jobSchema);
  const validateResults = ajv.compile(resultsSchema);
  const requestBody = { vacancyId: 'vac_demo_001', criteriaRevision: 'criteria-search-demo-r1', criteria: { keywords: ['Node.js'], regions: ['region_demo_001'] } };
  assert.equal(validateInput(requestBody), true);
  assert.equal(validateInput({ ...requestBody, profileId: 'profile_demo_001' }), false, 'profile is not model supplied');
  assert.equal(validateInput({ ...requestBody, criteria: { ...requestBody.criteria, unsafe: true } }), false);

  let currentCriteriaRevision = requestBody.criteriaRevision;
  let providerCalls = 0;
  const searchServer = createRecruitingServer({
    resolveTrustedProfileContext: req => ['profile_demo_001', 'profile_demo_002', 'profile_demo_003'].includes(req.headers['x-test-principal']) ? { profileId: req.headers['x-test-principal'], scopes: req.headers['x-test-principal'] === 'profile_demo_003' ? [] : ['recruiting.candidateSearch'] } : null,
    resolveCurrentSearchCriteriaRevision: () => currentCriteriaRevision,
    candidateSearchProvider: async args => { providerCalls++; return syntheticColdSearchProvider(args); }
  });
  await new Promise(resolve => searchServer.listen(0, '127.0.0.1', resolve));
  const searchBase = `http://127.0.0.1:${searchServer.address().port}`;
  const auth = principal => ({ 'X-Test-Principal': principal });
  const create = (body, key = 'r03-idempotency-1', principal = 'profile_demo_001') => fetch(`${searchBase}/api/v1/ui/candidate-searches`, { method: 'POST', headers: { ...auth(principal), 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${searchBase}/api/v1/ui/candidate-searches`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'no-principal-key' }, body: JSON.stringify(requestBody) })).status, 401);
    assert.equal((await create(requestBody, 'no-search-scope', 'profile_demo_003')).status, 403);

    const started = await create(requestBody);
    const initialJob = await started.json();
    assert.equal(started.status, 202);
    assert.equal(validateJob(initialJob), true, JSON.stringify(validateJob.errors));
    assert.equal(initialJob.status, 'partial');
    assert.equal(initialJob.resultCount, 2);
    assert.equal(initialJob.canResume, true);
    assert.equal(initialJob.ranking, 'provider_order_unranked');
    const duplicate = await create(requestBody);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).jobId, initialJob.jobId);
    assert.equal(providerCalls, 1, 'idempotent retry does not execute provider again');
    assert.equal((await create({ ...requestBody, criteriaRevision: 'criteria-search-demo-r2' })).status, 409, 'same key with changed query conflicts');

    const jobUrl = `/api/v1/ui/candidate-searches/${initialJob.jobId}`;
    assert.equal((await fetch(`${searchBase}${jobUrl}`, { headers: auth('profile_demo_002') })).status, 404, 'cross-profile job access denied');
    const firstPageResponse = await fetch(`${searchBase}${jobUrl}/results?limit=1`, { headers: auth('profile_demo_001') });
    const firstPage = await firstPageResponse.json();
    assert.equal(firstPageResponse.status, 200);
    assert.equal(validateResults(firstPage), true, JSON.stringify(validateResults.errors));
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor);
    assert.equal(firstPage.items[0].candidateRef, 'candidate_search_demo_001');

    const resumed = await fetch(`${searchBase}${jobUrl}/resume`, { method: 'POST', headers: auth('profile_demo_001') });
    const completedJob = await resumed.json();
    assert.equal(resumed.status, 200);
    assert.equal(completedJob.status, 'completed');
    assert.equal(completedJob.resultCount, 3);
    assert.equal(completedJob.canResume, false);
    const staleCursor = await fetch(`${searchBase}${jobUrl}/results?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers: auth('profile_demo_001') });
    assert.equal(staleCursor.status, 409, 'appending resumed results invalidates prior page cursor');
    assert.equal((await staleCursor.json()).error, 'stale_result_cursor');
    const completePage = await fetch(`${searchBase}${jobUrl}/results?limit=2`, { headers: auth('profile_demo_001') });
    const resultPage = await completePage.json();
    assert.equal(validateResults(resultPage), true, JSON.stringify(validateResults.errors));
    assert.equal(resultPage.items.length, 2);
    assert.ok(resultPage.nextCursor);
    const lastPage = await fetch(`${searchBase}${jobUrl}/results?limit=2&cursor=${encodeURIComponent(resultPage.nextCursor)}`, { headers: auth('profile_demo_001') });
    assert.equal((await (await lastPage.json()).items).length, 1);

    currentCriteriaRevision = 'criteria-search-demo-r2';
    const staleJob = await fetch(`${searchBase}${jobUrl}`, { headers: auth('profile_demo_001') });
    assert.equal(staleJob.status, 409);
    assert.equal((await staleJob.json()).error, 'stale_search_criteria');
    const staleResume = await fetch(`${searchBase}${jobUrl}/resume`, { method: 'POST', headers: auth('profile_demo_001') });
    assert.equal(staleResume.status, 409);
    assert.equal((await staleResume.json()).error, 'stale_search_criteria');
    const staleStart = await create(requestBody, 'r03-stale-start-key');
    assert.equal(staleStart.status, 409);
  } finally {
    await new Promise(resolve => searchServer.close(resolve));
    assert.deepEqual(await readFile(new URL('data/cold-search-results.json', root)), fixtureBefore);
  }

  const noRevisionServer = createRecruitingServer({ resolveTrustedProfileContext: () => ({ profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] }) });
  await new Promise(resolve => noRevisionServer.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${noRevisionServer.address().port}/api/v1/ui/candidate-searches`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'r03-no-revision' }, body: JSON.stringify(requestBody) });
    assert.equal(response.status, 503, 'missing current criteria revision fails closed');
    assert.deepEqual(await response.json(), { error: 'criteria_revision_unavailable' });
  } finally { await new Promise(resolve => noRevisionServer.close(resolve)); }

  const collisionServer = createRecruitingServer({
    resolveTrustedProfileContext: req => ({ profileId: req.headers['x-test-principal'], scopes: ['recruiting.candidateSearch'] }),
    resolveCurrentSearchCriteriaRevision: () => requestBody.criteriaRevision,
    candidateSearchProvider: async () => ({ kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [], nextCursor: null, complete: true })
  });
  await new Promise(resolve => collisionServer.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${collisionServer.address().port}/api/v1/ui/candidate-searches`;
    const startFor = (profile, key) => fetch(endpoint, { method: 'POST', headers: { 'X-Test-Principal': profile, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(requestBody) });
    const first = await (await startFor('profile_demo_001:a', 'key12345')).json();
    const second = await (await startFor('profile_demo_001', 'a:key12345')).json();
    assert.notEqual(first.jobId, second.jobId, 'profile/key pairs that collide under delimiter concatenation remain distinct');
    assert.equal((await (await startFor('profile_demo_001:a', 'key12345')).json()).jobId, first.jobId);
    assert.equal((await fetch(`http://127.0.0.1:${collisionServer.address().port}/api/v1/ui/candidate-searches/${first.jobId}`, { headers: { 'X-Test-Principal': 'profile_demo_001' } })).status, 404);
  } finally { await new Promise(resolve => collisionServer.close(resolve)); }

  const partialCalls = [];
  let transientFailures = 0;
  const partialErrorServer = createRecruitingServer({
    resolveTrustedProfileContext: () => ({ profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] }),
    resolveCurrentSearchCriteriaRevision: () => requestBody.criteriaRevision,
    candidateSearchProvider: async ({ cursor }) => {
      partialCalls.push(cursor);
      if (cursor === null) return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [{ candidateRef: 'candidate_search_demo_009', vacancyId: 'vac_demo_001', title: 'Synthetic engineer', region: 'Synthetic region', evidenceSummary: 'Synthetic evidence' }], nextCursor: 'after-one', complete: false };
      if (cursor === 'after-one' && transientFailures++ === 0) throw Object.assign(new Error('private provider detail'), { status: 503 });
      return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [], nextCursor: null, complete: true };
    }
  });
  await new Promise(resolve => partialErrorServer.listen(0, '127.0.0.1', resolve));
  const failureBase = `http://127.0.0.1:${partialErrorServer.address().port}`;
  try {
    const headers = { 'X-Test-Principal': 'profile_demo_001', 'Content-Type': 'application/json', 'Idempotency-Key': 'r03-partial-error-key' };
    const first = await fetch(`${failureBase}/api/v1/ui/candidate-searches`, { method: 'POST', headers, body: JSON.stringify(requestBody) });
    const firstJob = await first.json();
    assert.equal(firstJob.status, 'partial');
    const second = await fetch(`${failureBase}/api/v1/ui/candidate-searches/${firstJob.jobId}/resume`, { method: 'POST', headers: { 'X-Test-Principal': 'profile_demo_001' } });
    const erroredJob = await second.json();
    assert.equal(validateJob(erroredJob), true, JSON.stringify(validateJob.errors));
    assert.equal(erroredJob.status, 'partial');
    assert.equal(erroredJob.canResume, true);
    assert.deepEqual(erroredJob.providerError, { code: 'provider_unavailable', retryable: true });
    const recovered = await fetch(`${failureBase}/api/v1/ui/candidate-searches/${firstJob.jobId}/resume`, { method: 'POST', headers: { 'X-Test-Principal': 'profile_demo_001' } });
    assert.equal((await recovered.json()).status, 'completed');
    assert.deepEqual(partialCalls, [null, 'after-one', 'after-one']);
  } finally { await new Promise(resolve => partialErrorServer.close(resolve)); }

  const forbiddenServer = createRecruitingServer({ resolveTrustedProfileContext: () => ({ profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] }), resolveCurrentSearchCriteriaRevision: () => requestBody.criteriaRevision, candidateSearchProvider: async () => ({ kind: 'error', code: 'provider_forbidden', retryable: false }) });
  await new Promise(resolve => forbiddenServer.listen(0, '127.0.0.1', resolve));
  try {
    const failed = await fetch(`http://127.0.0.1:${forbiddenServer.address().port}/api/v1/ui/candidate-searches`, { method: 'POST', headers: { 'X-Test-Principal': 'profile_demo_001', 'Content-Type': 'application/json', 'Idempotency-Key': 'r03-forbidden-key' }, body: JSON.stringify(requestBody) });
    const failedJob = await failed.json();
    assert.equal(validateJob(failedJob), true, JSON.stringify(validateJob.errors));
    assert.equal(failedJob.status, 'failed');
    assert.equal(failedJob.resultCount, 0);
    assert.equal(failedJob.canResume, false);
    assert.deepEqual(failedJob.providerError, { code: 'provider_forbidden', retryable: false });
  } finally { await new Promise(resolve => forbiddenServer.close(resolve)); }

  const boundedServer = createRecruitingServer({ resolveTrustedProfileContext: () => ({ profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] }), resolveCurrentSearchCriteriaRevision: () => requestBody.criteriaRevision, candidateSearchProvider: async () => ({ kind: 'error', code: 'provider_unavailable', retryable: true }), maxCandidateSearchJobs: 1 });
  await new Promise(resolve => boundedServer.listen(0, '127.0.0.1', resolve));
  try {
    const boundedBase = `http://127.0.0.1:${boundedServer.address().port}/api/v1/ui/candidate-searches`;
    const headers = { 'X-Test-Principal': 'profile_demo_001', 'Content-Type': 'application/json', 'Idempotency-Key': 'r03-capacity-key' };
    assert.equal((await fetch(boundedBase, { method: 'POST', headers, body: JSON.stringify(requestBody) })).status, 202);
    assert.equal((await fetch(boundedBase, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'r03-capacity-key-2' }, body: JSON.stringify(requestBody) })).status, 429);
  } finally { await new Promise(resolve => boundedServer.close(resolve)); }

  let forbiddenAfterPageCalls = 0;
  const forbiddenAfterPageServer = createRecruitingServer({
    resolveTrustedProfileContext: () => ({ profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] }),
    resolveCurrentSearchCriteriaRevision: () => requestBody.criteriaRevision,
    candidateSearchProvider: async () => {
      forbiddenAfterPageCalls++;
      if (forbiddenAfterPageCalls === 1) return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [{ candidateRef: 'candidate_search_demo_008', vacancyId: 'vac_demo_001', title: 'Synthetic engineer', region: 'Synthetic region', evidenceSummary: 'Synthetic evidence' }], nextCursor: 'next-page', complete: false };
      return { kind: 'error', code: 'provider_forbidden', retryable: true };
    }
  });
  await new Promise(resolve => forbiddenAfterPageServer.listen(0, '127.0.0.1', resolve));
  try {
    const root = `http://127.0.0.1:${forbiddenAfterPageServer.address().port}/api/v1/ui/candidate-searches`;
    const headers = { 'X-Test-Principal': 'profile_demo_001', 'Content-Type': 'application/json', 'Idempotency-Key': 'r03-forbidden-after-page' };
    const first = await fetch(root, { method: 'POST', headers, body: JSON.stringify(requestBody) });
    const started = await first.json();
    const blocked = await fetch(`${root}/${started.jobId}/resume`, { method: 'POST', headers: { 'X-Test-Principal': 'profile_demo_001' } });
    const partialForbidden = await blocked.json();
    assert.equal(partialForbidden.status, 'partial');
    assert.equal(partialForbidden.resultCount, 1);
    assert.equal(partialForbidden.canResume, false);
    assert.deepEqual(partialForbidden.providerError, { code: 'provider_forbidden', retryable: false });
    assert.equal((await fetch(`${root}/${started.jobId}/resume`, { method: 'POST', headers: { 'X-Test-Principal': 'profile_demo_001' } })).status, 409);
    assert.equal(forbiddenAfterPageCalls, 2);
  } finally { await new Promise(resolve => forbiddenAfterPageServer.close(resolve)); }

  let cursorCalls = 0;
  const cursorLoopServer = createRecruitingServer({
    resolveTrustedProfileContext: () => ({ profileId: 'profile_demo_001', scopes: ['recruiting.candidateSearch'] }),
    resolveCurrentSearchCriteriaRevision: () => requestBody.criteriaRevision,
    candidateSearchProvider: async ({ cursor }) => {
      cursorCalls++;
      if (cursor === null) return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [{ candidateRef: 'candidate_search_demo_007', vacancyId: 'vac_demo_001', title: 'Synthetic engineer', region: 'Synthetic region', evidenceSummary: 'Synthetic evidence' }], nextCursor: 'stuck-cursor', complete: false };
      return { kind: 'page', sourceRevision: 'cold-search-provider-demo-r1', items: [], nextCursor: 'stuck-cursor', complete: false };
    }
  });
  await new Promise(resolve => cursorLoopServer.listen(0, '127.0.0.1', resolve));
  try {
    const root = `http://127.0.0.1:${cursorLoopServer.address().port}/api/v1/ui/candidate-searches`;
    const started = await (await fetch(root, { method: 'POST', headers: { 'X-Test-Principal': 'profile_demo_001', 'Content-Type': 'application/json', 'Idempotency-Key': 'r03-stuck-cursor' }, body: JSON.stringify(requestBody) })).json();
    const resumed = await fetch(`${root}/${started.jobId}/resume`, { method: 'POST', headers: { 'X-Test-Principal': 'profile_demo_001' } });
    const loopRejected = await resumed.json();
    assert.equal(loopRejected.status, 'partial');
    assert.equal(loopRejected.canResume, false);
    assert.deepEqual(loopRejected.providerError, { code: 'provider_invalid_response', retryable: false });
    assert.equal(cursorCalls, 2);
  } finally { await new Promise(resolve => cursorLoopServer.close(resolve)); }

  const advertised = (await (await get('/api/v1/capabilities')).json()).capabilities;
  assert.equal(advertised.some(item => item.id.includes('candidateSearch')), false, 'cold-search routes stay outside C14 capability discovery');
  assert.equal((await fetch(`${base}/api/v1/ui/candidate-searches`, { method: 'DELETE' })).status, 405);
});

test('browser landing page is useful and all writes are rejected', async () => {
  const page = await get('/');
  const html = await page.text();
  assert.match(html, /Recruiting API demo/);
  assert.match(html, /Select a vacancy/);
  assert.match(html, /Read-only responses/);
  assert.match(html, /not agent capabilities/);
  assert.match(html, /Load more responses/);
  assert.match(html, /Client report draft preview/);
  assert.match(html, /not saved, published, or shared/);
  assert.match(html, /not production authentication/);
  assert.equal((await fetch(`${base}/api/v1/vacancies`, { method: 'POST' })).status, 405);
});

test('unknown paths return 404', async () => {
  assert.equal((await get('/unknown')).status, 404);
});
