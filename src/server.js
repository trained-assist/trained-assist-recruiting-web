import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getProfile, listProfileVacancies, profileHasScope, readVacancyResponses } from './recruiting-domain.js';
import { createClientReportPreview, findReportSource, findReportVacancy } from './report-preview.js';
import { createReportDrafts } from './report-drafts.js';
import { evaluateSyntheticResponse, getResponseScenario, makeEvaluationId, validEvaluatorOutput } from './response-evaluation.js';
import { createCandidateSearchJobs } from './candidate-search-jobs.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const vacancies = JSON.parse(await readFile(join(root, 'data/vacancies.json'), 'utf8'));
const landingPage = await readFile(join(root, 'public/index.html'), 'utf8');
const release = {
  version: '0.1.0',
  sourceRevision: process.env.SOURCE_REVISION ?? 'unversioned-local',
  environment: 'local'
};
const platformContractRange = '>=1.0.0 <2.0.0';
const readiness = {
  status: 'ready',
  reason: {
    code: 'synthetic_fixture_service',
    message: 'Ready for local synthetic-fixture use only; no production data or integrations are connected.'
  },
  checkedVersionTuple: {
    releaseVersion: release.version,
    sourceRevision: release.sourceRevision,
    environment: release.environment,
    platformContractRange,
    domainApiVersion: 'v1'
  }
};
const capabilities = [{
  id: 'recruiting.vacancies.list',
  version: '1.0.0',
  required: true,
  inputSchemaRef: 'contracts/v1-vacancies-query.schema.json',
  outputSchemaRef: 'contracts/v1-vacancies.schema.json',
  effect: 'read',
  requiredScopes: [],
  operationRef: 'GET /api/v1/vacancies'
}];
const manifest = {
  serviceId: 'trained-assist.recruiting',
  release,
  platformContractRange,
  domainApiVersion: 'v1',
  capabilities,
  readiness,
  compatibility: { deprecatedCapabilities: [] },
  endpoints: {
    manifest: '/api/v1/manifest',
    capabilities: '/api/v1/capabilities',
    readiness: '/api/v1/readiness',
    vacancies: '/api/v1/vacancies'
  }
};
const mime = { json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8' };

function parseResponsePageOptions(url) {
  const params = url.searchParams;
  const keys = [...params.keys()];
  if (keys.some(key => !['limit', 'cursor'].includes(key)) || new Set(keys).size !== keys.length) {
    return { error: 'unexpected_query_parameters' };
  }
  const rawLimit = params.get('limit');
  if (rawLimit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) return { error: 'invalid_page_request' };
  return { limit: rawLimit === null ? 25 : Number(rawLimit), cursor: params.get('cursor') };
}

function parseReportPreviewQuery(url) {
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => !['candidateId', 'vacancyId'].includes(key)) || new Set(keys).size !== keys.length) return null;
  const candidateId = url.searchParams.get('candidateId');
  const vacancyId = url.searchParams.get('vacancyId');
  if (!candidateId || !vacancyId || !/^candidate_demo_[0-9]{3}$/.test(candidateId) || !/^vac_demo_[0-9]{3}$/.test(vacancyId)) return null;
  return { candidateId, vacancyId };
}

function parseEvaluationQuery(url) {
  const fields = ['responseId', 'vacancyId', 'expectedResponseRevision', 'expectedResumeRevision', 'expectedCriteriaRevision'];
  const keys = [...url.searchParams.keys()];
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || new Set(keys).size !== keys.length) return null;
  const value = Object.fromEntries(fields.map(key => [key, url.searchParams.get(key)]));
  if (!/^response_demo_[0-9]{3}$/.test(value.responseId) || !/^vac_demo_[0-9]{3}$/.test(value.vacancyId) ||
      !/^response-demo-[0-9]{3}-r[0-9]+$/.test(value.expectedResponseRevision) ||
      !/^resume-demo-[0-9]{3}-r[0-9]+$/.test(value.expectedResumeRevision) ||
      !/^criteria-vac-demo-[0-9]{3}-r[0-9]+$/.test(value.expectedCriteriaRevision)) return null;
  return value;
}

async function readJsonBody(req, maxBytes = 16_384) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('body_too_large');
  }
  return JSON.parse(raw);
}

function parseSearchResultPage(url) {
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => !['limit', 'cursor'].includes(key)) || new Set(keys).size !== keys.length) return null;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) return null;
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))) return null;
  return { limit: rawLimit === null ? 25 : Number(rawLimit), cursor };
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isReportRevision = value => typeof value === 'string' && /^report-demo-r[0-9]+$/.test(value);

function validReportDraftStart(value) {
  return isPlainObject(value) && Object.keys(value).sort().join(',') === 'candidateId,expectedSourceRevision,vacancyId' &&
    /^candidate_demo_[0-9]{3}$/.test(value.candidateId ?? '') && /^vac_demo_[0-9]{3}$/.test(value.vacancyId ?? '') &&
    /^synthetic-[a-z0-9-]+-r[0-9]+$/.test(value.expectedSourceRevision ?? '');
}

function validReportClientPatch(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0 || Object.keys(value).some(key => !['summary', 'experience', 'fit', 'conclusion'].includes(key))) return false;
  if ('summary' in value && (typeof value.summary !== 'string' || value.summary.length > 3000)) return false;
  if ('conclusion' in value && (typeof value.conclusion !== 'string' || value.conclusion.length > 1500)) return false;
  if ('experience' in value && (!Array.isArray(value.experience) || value.experience.length > 10 || !value.experience.every(item =>
    isPlainObject(item) && Object.keys(item).sort().join(',') === 'company,details,period,role' &&
    ['company', 'role'].every(key => typeof item[key] === 'string' && item[key].length <= 200) &&
    typeof item.period === 'string' && item.period.length <= 100 && Array.isArray(item.details) && item.details.length <= 10 && item.details.every(detail => typeof detail === 'string' && detail.length <= 500)))) return false;
  if ('fit' in value && (!Array.isArray(value.fit) || value.fit.length > 20 || !value.fit.every(item =>
    isPlainObject(item) && Object.keys(item).sort().join(',') === 'comment,requirement,status' &&
    typeof item.requirement === 'string' && item.requirement.length <= 300 && ['yes', 'partial', 'no'].includes(item.status) &&
    typeof item.comment === 'string' && item.comment.length <= 1000))) return false;
  return true;
}

function validReportAction(value) {
  return isPlainObject(value) && Object.keys(value).sort().join(',') === 'expectedReportRevision' && isReportRevision(value.expectedReportRevision);
}

export function createRecruitingServer({ resolveTrustedProfileContext = () => null, evaluator = evaluateSyntheticResponse, candidateSearchProvider, resolveCurrentSearchCriteriaRevision = () => null, maxCandidateSearchJobs = 100, publicationAdapter, resolveCurrentReportSourceRevision = (_context, candidateId, vacancyId) => { const source = findReportSource(candidateId); return source?.vacancyId === vacancyId ? source.sourceRevision : null; } } = {}) {
  const candidateSearchJobs = createCandidateSearchJobs({ provider: candidateSearchProvider, maxJobs: maxCandidateSearchJobs });
  const reportDrafts = createReportDrafts({ publicationAdapter });
  const currentSearchCriteriaRevision = async (context, vacancyId) => {
    try {
      const revision = await resolveCurrentSearchCriteriaRevision(context, vacancyId);
      return typeof revision === 'string' && /^criteria-search-demo-r[0-9]+$/.test(revision) ? revision : null;
    } catch { return null; }
  };
  const currentReportRevision = async (context, candidateId, vacancyId) => {
    try {
      const revision = await resolveCurrentReportSourceRevision(context, candidateId, vacancyId);
      return typeof revision === 'string' && /^synthetic-[a-z0-9-]+-r[0-9]+$/.test(revision) ? revision : null;
    } catch { return null; }
  };
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const isCandidateSearchPath = path === '/api/v1/ui/candidate-searches' || /^\/api\/v1\/ui\/candidate-searches\/[^/]+(?:\/results|\/resume)?$/.test(path);
    const reportDraftRoot = '/api/v1/ui/report-drafts';
    const isReportDraftPath = path === reportDraftRoot || new RegExp(`^${reportDraftRoot}/report_demo_[a-f0-9]{12}(?:/preview|/review|/publish|/revoke)?$`).test(path);
    let status = 200;
    let type = mime.json;
    let body;

    if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && (isCandidateSearchPath || isReportDraftPath)) && !(req.method === 'PATCH' && isReportDraftPath)) {
      status = 405;
      body = { error: 'method_not_allowed' };
      res.setHeader('Allow', isCandidateSearchPath || isReportDraftPath ? 'GET, HEAD, POST, PATCH' : 'GET, HEAD');
    } else if (path === '/') {
      type = mime.html;
      body = landingPage;
    } else if (path === '/health/ready') {
      body = { status: 'ready' };
    } else if (path === '/api/v1/readiness') {
      body = { serviceId: manifest.serviceId, domainApiVersion: manifest.domainApiVersion, ...readiness };
    } else if (path === '/api/v1/manifest') {
      body = manifest;
    } else if (path === '/api/v1/capabilities') {
      body = { serviceId: manifest.serviceId, domainApiVersion: manifest.domainApiVersion, capabilities };
    } else if (path === '/api/v1/vacancies') {
      if (url.search !== '') {
        status = 400;
        body = { error: 'unexpected_query_parameters' };
      } else {
        body = { apiVersion: 'v1', items: vacancies };
      }
    } else if (isReportDraftPath) {
      const context = await resolveTrustedProfileContext(req);
      if (!context || typeof context.profileId !== 'string' || !Array.isArray(context.scopes)) {
        status = 401;
        body = { error: 'trusted_profile_context_required' };
      } else if (path === reportDraftRoot && req.method === 'POST') {
        if (!context.scopes.includes('recruiting.reports.create')) {
          status = 403;
          body = { error: 'report_create_scope_required' };
        } else {
          let request;
          try { request = await readJsonBody(req); } catch (error) {
            status = error.message === 'body_too_large' ? 413 : 400;
            body = { error: error.message === 'body_too_large' ? 'request_too_large' : 'invalid_json' };
          }
          if (status === 200) {
            const key = req.headers['idempotency-key'];
            if (!validReportDraftStart(request) || typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
              status = 400;
              body = { error: 'invalid_report_draft_start' };
            } else {
              const source = findReportSource(request.candidateId);
              const vacancy = findReportVacancy(request.vacancyId);
              if (!source || !vacancy) {
                status = 404;
                body = { error: 'not_found' };
              } else if (source.vacancyId !== request.vacancyId) {
                status = 409;
                body = { error: 'candidate_vacancy_mismatch' };
              } else {
                const currentRevision = await currentReportRevision(context, request.candidateId, request.vacancyId);
                if (!currentRevision) {
                  status = 503;
                  body = { error: 'source_revision_unavailable' };
                } else {
                  const created = reportDrafts.create(context.profileId, key, request, currentRevision);
                  if (created.kind === 'stale_source') {
                    status = 409;
                    body = { error: 'stale_report_source', expectedSourceRevision: created.expected, currentSourceRevision: created.current };
                  } else if (created.kind === 'idempotency_conflict') {
                    status = 409;
                    body = { error: 'idempotency_key_reused' };
                  } else if (created.kind === 'source_revision_unavailable') {
                    status = 503;
                    body = { error: 'source_revision_unavailable' };
                  } else {
                    status = created.kind === 'created' ? 201 : 200;
                    body = created.report;
                  }
                }
              }
            }
          }
        }
      } else {
        const match = path.match(/^\/api\/v1\/ui\/report-drafts\/(report_demo_[a-f0-9]{12})(?:\/(preview|review|publish|revoke))?$/);
        const reportRef = match?.[1];
        const action = match?.[2] ?? '';
        const reportResult = reportDrafts.get(context.profileId, reportRef);
        if (reportResult.kind === 'not_found') {
          status = 404;
          body = { error: 'not_found' };
        } else if (reportResult.kind === 'revoked' && action !== 'revoke') {
          status = 410;
          body = { error: 'report_revoked' };
        } else if (action === 'revoke' && req.method === 'POST') {
          if (!context.scopes.includes('recruiting.reports.revoke')) {
            status = 403;
            body = { error: 'report_revoke_scope_required' };
          } else {
            let request;
            try { request = await readJsonBody(req); } catch { status = 400; body = { error: 'invalid_json' }; }
            if (status === 200) {
              if (!validReportAction(request)) { status = 400; body = { error: 'invalid_report_action' }; }
              else {
                const result = await reportDrafts.revoke(context.profileId, reportRef, request.expectedReportRevision);
                if (result.kind === 'stale_report') { status = 409; body = { error: 'stale_report_revision', currentReportRevision: result.currentReportRevision }; }
                else if (result.kind === 'not_revokeable') { status = 409; body = { error: 'report_not_revokeable', report: result.report }; }
                else if (result.kind === 'revocation_denied') { status = 403; body = { error: 'revocation_denied', report: result.report }; }
                else if (result.kind === 'revocation_outcome_unknown') { status = 503; body = { error: 'revocation_outcome_unknown', operationId: result.operationId, report: result.report }; }
                else if (result.kind === 'operation_in_progress') { status = 409; body = { error: 'report_operation_in_progress', operationId: result.operationId, report: result.report }; }
                else if (result.kind === 'operation_outcome_unknown') { status = 409; body = { error: 'report_operation_outcome_unknown', operationId: result.operationId, report: result.report }; }
                else { body = result.report; }
              }
            }
          }
        } else {
          const requiredScope = action === 'review' ? 'recruiting.reports.review' : action === 'publish' ? 'recruiting.reports.publish' : req.method === 'PATCH' ? 'recruiting.reports.edit' : 'recruiting.reports.read';
          if (!context.scopes.includes(requiredScope)) {
            status = 403;
            body = { error: 'report_scope_required' };
          } else {
            const currentRevision = await currentReportRevision(context, reportResult.report.candidateId, reportResult.report.vacancyId);
            if (!currentRevision) {
              status = 503;
              body = { error: 'source_revision_unavailable' };
            } else if (currentRevision !== reportResult.report.sourceRevision) {
              status = 409;
              body = { error: 'stale_report_source', expectedSourceRevision: reportResult.report.sourceRevision, currentSourceRevision: currentRevision };
            } else if (!action && req.method === 'GET' && url.search === '') {
              body = reportResult.report;
            } else if (action === 'preview' && req.method === 'GET' && url.search === '') {
              const preview = reportDrafts.preview(context.profileId, reportRef);
              if (preview.kind === 'revoked') { status = 410; body = { error: 'report_revoked' }; }
              else body = preview.body;
            } else if (!action && req.method === 'PATCH') {
              let request;
              try { request = await readJsonBody(req); } catch (error) { status = error.message === 'body_too_large' ? 413 : 400; body = { error: 'invalid_json' }; }
              if (status === 200) {
                if (!isPlainObject(request) || Object.keys(request).sort().join(',') !== 'clientFields,expectedReportRevision' || !isReportRevision(request.expectedReportRevision) || !validReportClientPatch(request.clientFields)) {
                  status = 400;
                  body = { error: 'invalid_client_report_edit' };
                } else {
                  const updated = reportDrafts.edit(context.profileId, reportRef, request.expectedReportRevision, request.clientFields);
                  if (updated.kind === 'stale_report') { status = 409; body = { error: 'stale_report_revision', currentReportRevision: updated.currentReportRevision }; }
                  else if (updated.kind === 'operation_in_progress') { status = 409; body = { error: 'report_operation_in_progress', operationId: updated.operationId, report: updated.report }; }
                  else if (updated.kind === 'operation_outcome_unknown') { status = 409; body = { error: 'report_operation_outcome_unknown', operationId: updated.operationId, report: updated.report }; }
                  else if (updated.kind === 'not_editable') { status = 409; body = { error: 'report_not_editable', report: updated.report }; }
                  else body = updated.report;
                }
              }
            } else if (action === 'review' && req.method === 'POST') {
              let request;
              try { request = await readJsonBody(req); } catch { status = 400; body = { error: 'invalid_json' }; }
              if (status === 200) {
                if (!isPlainObject(request) || Object.keys(request).sort().join(',') !== 'decision,expectedReportRevision' || !isReportRevision(request.expectedReportRevision) || !['approved', 'changes_requested'].includes(request.decision)) {
                  status = 400;
                  body = { error: 'invalid_report_review' };
                } else {
                  const reviewed = reportDrafts.review(context.profileId, reportRef, request.expectedReportRevision, request.decision);
                  if (reviewed.kind === 'stale_report') { status = 409; body = { error: 'stale_report_revision', currentReportRevision: reviewed.currentReportRevision }; }
                  else if (reviewed.kind === 'operation_in_progress') { status = 409; body = { error: 'report_operation_in_progress', operationId: reviewed.operationId, report: reviewed.report }; }
                  else if (reviewed.kind === 'operation_outcome_unknown') { status = 409; body = { error: 'report_operation_outcome_unknown', operationId: reviewed.operationId, report: reviewed.report }; }
                  else if (reviewed.kind === 'not_reviewable') { status = 409; body = { error: 'report_not_reviewable', report: reviewed.report }; }
                  else body = reviewed.report;
                }
              }
            } else if (action === 'publish' && req.method === 'POST') {
              let request;
              try { request = await readJsonBody(req); } catch { status = 400; body = { error: 'invalid_json' }; }
              if (status === 200) {
                if (!validReportAction(request)) { status = 400; body = { error: 'invalid_report_action' }; }
                else {
                  const published = await reportDrafts.publish(context.profileId, reportRef, request.expectedReportRevision);
                  if (published.kind === 'stale_report') { status = 409; body = { error: 'stale_report_revision', currentReportRevision: published.currentReportRevision }; }
                  else if (published.kind === 'review_required') { status = 409; body = { error: 'report_review_required', report: published.report }; }
                  else if (published.kind === 'publication_denied') { status = 403; body = { error: 'publication_denied', report: published.report }; }
                  else if (published.kind === 'publication_outcome_unknown') { status = 503; body = { error: 'publication_outcome_unknown', operationId: published.operationId, report: published.report }; }
                  else if (published.kind === 'operation_in_progress') { status = 409; body = { error: 'report_operation_in_progress', operationId: published.operationId, report: published.report }; }
                  else if (published.kind === 'operation_outcome_unknown') { status = 409; body = { error: 'report_operation_outcome_unknown', operationId: published.operationId, report: published.report }; }
                  else if (published.kind === 'not_publishable') { status = 409; body = { error: 'report_not_publishable', report: published.report }; }
                  else body = published.report;
                }
              }
            } else {
              status = 404;
              body = { error: 'not_found' };
            }
          }
        }
      }
    } else if (isCandidateSearchPath) {
      const context = await resolveTrustedProfileContext(req);
      if (!context || typeof context.profileId !== 'string' || !Array.isArray(context.scopes)) {
        status = 401;
        body = { error: 'trusted_profile_context_required' };
      } else if (!context.scopes.includes('recruiting.candidateSearch')) {
        status = 403;
        body = { error: 'search_scope_required' };
      } else if (path === '/api/v1/ui/candidate-searches' && req.method === 'POST') {
        let request;
        try { request = await readJsonBody(req); } catch (error) {
          status = error.message === 'body_too_large' ? 413 : 400;
          body = { error: error.message === 'body_too_large' ? 'request_too_large' : 'invalid_json' };
        }
        if (status === 200) {
          const key = req.headers['idempotency-key'];
          const validRequest = request && /^vac_demo_[0-9]{3}$/.test(request.vacancyId ?? '') &&
            /^criteria-search-demo-r[0-9]+$/.test(request.criteriaRevision ?? '') && request.criteria &&
            Array.isArray(request.criteria.keywords) && Array.isArray(request.criteria.regions) &&
            Object.keys(request).every(field => ['vacancyId', 'criteriaRevision', 'criteria'].includes(field)) &&
            Object.keys(request.criteria).every(field => ['keywords', 'regions'].includes(field)) &&
            request.criteria.keywords.length <= 8 && request.criteria.regions.length <= 8 &&
            request.criteria.keywords.every(item => typeof item === 'string' && item.length > 0 && item.length <= 100) &&
            request.criteria.regions.every(item => typeof item === 'string' && /^region_demo_[0-9]{3}$/.test(item));
          if (!validRequest || typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
            status = 400;
            body = { error: 'invalid_search_start' };
          } else {
            const currentRevision = await currentSearchCriteriaRevision(context, request.vacancyId);
            if (!currentRevision) {
              status = 503;
              body = { error: 'criteria_revision_unavailable' };
            } else if (currentRevision !== request.criteriaRevision) {
              status = 409;
              body = { domainApiVersion: 'v1', error: 'stale_search_criteria', requestedRevision: request.criteriaRevision, currentRevision };
            } else {
              const started = await candidateSearchJobs.start(context.profileId, key, request);
              if (started.conflict) {
                status = 409;
                body = { error: 'idempotency_key_reused' };
              } else if (started.capacityExceeded) {
                status = 429;
                body = { error: 'search_job_capacity_reached' };
              } else {
                status = started.created ? 202 : 200;
                body = started.job;
              }
            }
          }
        }
      } else {
        const route = path.match(/^\/api\/v1\/ui\/candidate-searches\/([^/]+)(\/results|\/resume)?$/);
        const jobId = route?.[1];
        const subpath = route?.[2] ?? '';
        const job = candidateSearchJobs.get(context.profileId, jobId);
        if (!job) {
          status = 404;
          body = { error: 'not_found' };
        } else {
          const currentRevision = await currentSearchCriteriaRevision(context, job.vacancyId);
          if (!currentRevision) {
            status = 503;
            body = { error: 'criteria_revision_unavailable' };
          } else if (currentRevision !== job.criteriaRevision) {
            status = 409;
            body = { domainApiVersion: 'v1', error: 'stale_search_criteria', requestedRevision: job.criteriaRevision, currentRevision };
          } else if (subpath === '/results' && (req.method === 'GET' || req.method === 'HEAD')) {
            const page = parseSearchResultPage(url);
            if (!page) {
              status = 400;
              body = { error: 'invalid_result_page' };
            } else {
              const results = candidateSearchJobs.results(context.profileId, jobId, page);
              if (results.kind === 'invalid_cursor') { status = 400; body = { error: 'invalid_cursor' }; }
              else if (results.kind === 'stale_cursor') { status = 409; body = { domainApiVersion: 'v1', error: 'stale_result_cursor', currentRevision: results.currentRevision }; }
              else body = results;
            }
          } else if (subpath === '/resume' && req.method === 'POST') {
            const resumed = await candidateSearchJobs.resume(context.profileId, jobId);
            if (resumed.conflict) { status = 409; body = { error: 'job_not_resumable', job: resumed.job }; }
            else body = resumed.job;
          } else if (!subpath && (req.method === 'GET' || req.method === 'HEAD') && url.search === '') {
            body = job;
          } else {
            status = 404;
            body = { error: 'not_found' };
          }
        }
      }
    } else if (path === '/api/v1/ui/report-previews') {
      const query = parseReportPreviewQuery(url);
      if (!query) {
        status = 400;
        body = { error: 'invalid_preview_query' };
      } else {
        const preview = createClientReportPreview(query.candidateId, query.vacancyId);
        if (preview.kind === 'candidate_not_found' || preview.kind === 'vacancy_not_found') {
          status = 404;
          body = { error: 'not_found' };
        } else if (preview.kind === 'candidate_vacancy_mismatch') {
          status = 409;
          body = { error: 'candidate_vacancy_mismatch' };
        } else {
          body = preview.body;
        }
      }
    } else if (path === '/api/v1/ui/response-evaluations') {
      const context = resolveTrustedProfileContext(req);
      if (!context || typeof context.profileId !== 'string' || !Array.isArray(context.scopes)) {
        status = 401;
        body = { error: 'trusted_profile_context_required' };
      } else if (!context.scopes.includes('recruiting.responses.evaluate')) {
        status = 403;
        body = { error: 'evaluation_scope_required' };
      } else {
        const query = parseEvaluationQuery(url);
        if (!query) {
          status = 400;
          body = { error: 'invalid_evaluation_query' };
        } else {
          const scenario = getResponseScenario(query.responseId);
          if (!scenario || scenario.profileId !== context.profileId) {
            status = 404;
            body = { error: 'not_found' };
          } else if (query.vacancyId !== scenario.vacancyId) {
            status = 409;
            body = { error: 'response_vacancy_mismatch' };
          } else {
            const currentSourceRevisions = { response: scenario.responseRevision, resume: scenario.resumeRevision, vacancyCriteria: scenario.criteriaRevision };
            const requested = { response: query.expectedResponseRevision, resume: query.expectedResumeRevision, vacancyCriteria: query.expectedCriteriaRevision };
            const staleRevisions = Object.keys(requested).filter(key => requested[key] !== currentSourceRevisions[key]).map(source => ({ source, requested: requested[source], current: currentSourceRevisions[source] }));
            if (staleRevisions.length) {
              status = 409;
              body = { domainApiVersion: 'v1', error: 'stale_evaluation_inputs', staleRevisions, currentSourceRevisions };
            } else {
              let evaluated;
              try {
                evaluated = await evaluator({ resume: scenario.resume, criteria: scenario.criteria });
              } catch {
                status = 503;
                body = { error: 'evaluator_unavailable' };
              }
              if (status !== 503 && !validEvaluatorOutput(evaluated, scenario.criteria)) {
                status = 502;
                body = { error: 'invalid_evaluator_output' };
              } else if (status !== 503) {
                body = { domainApiVersion: 'v1', evaluationId: makeEvaluationId(scenario), responseId: scenario.responseId, vacancyId: scenario.vacancyId, sourceRevisions: currentSourceRevisions, ...evaluated };
              }
            }
          }
        }
      }
    } else {
      const responseRoute = path.match(/^\/api\/v1\/profiles\/([^/]+)\/vacancies\/([^/]+)\/responses$/);
      const vacancyRoute = path.match(/^\/api\/v1\/profiles\/([^/]+)\/vacancies$/);
      const route = responseRoute ?? vacancyRoute;
      if (route) {
        const profileId = route[1];
        const demoProfileId = req.headers['x-demo-profile-id'];
        if (typeof demoProfileId !== 'string') {
          status = 401;
          body = { error: 'demo_profile_required' };
        } else if (demoProfileId !== profileId) {
          status = 403;
          body = { error: 'demo_profile_mismatch' };
        } else if (!getProfile(profileId)) {
          status = 404;
          body = { error: 'not_found' };
        } else if (!profileHasScope(profileId, responseRoute ? 'recruiting.responses.read' : 'recruiting.profile.read')) {
          status = 403;
          body = { error: 'demo_scope_required' };
        } else if (responseRoute) {
          const [, , vacancyId] = responseRoute;
          const pageOptions = parseResponsePageOptions(url);
          if (pageOptions.error) {
            status = 400;
            body = { error: pageOptions.error };
          } else {
            const page = readVacancyResponses(profileId, vacancyId, pageOptions);
            if (page === null) {
              status = 404;
              body = { error: 'not_found' };
            } else if (page.kind === 'invalid_cursor') {
              status = 400;
              body = { error: 'invalid_cursor' };
            } else if (page.kind === 'stale_cursor') {
              status = 409;
              body = {
                domainApiVersion: 'v1',
                profileId,
                vacancyId,
                freshness: 'stale',
                error: 'stale_cursor',
                requestedRevision: page.requestedRevision,
                currentRevision: page.currentRevision
              };
            } else {
              body = {
                domainApiVersion: 'v1',
                profileId,
                vacancyId,
                revision: page.revision,
                freshness: page.freshness,
                items: page.items,
                nextCursor: page.nextCursor
              };
            }
          }
        } else if (url.search !== '') {
          status = 400;
          body = { error: 'unexpected_query_parameters' };
        } else {
          const items = listProfileVacancies(profileId);
          if (items === null) {
            status = 404;
            body = { error: 'not_found' };
          } else {
            body = { domainApiVersion: 'v1', profileId, items };
          }
        }
      } else {
        status = 404;
        body = { error: 'not_found' };
      }
    }

    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  createRecruitingServer().listen(port, '127.0.0.1', () => {
    console.log(`Recruiting demo listening on http://127.0.0.1:${port}`);
  });
}
