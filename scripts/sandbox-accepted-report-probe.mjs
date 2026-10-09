import { randomUUID } from 'node:crypto';

const origin = process.env.RECRUITING_SANDBOX_PUBLIC_ORIGIN;
const candidateId = 'candidate_search_demo_001';
const vacancyId = 'vac_demo_001';
if (typeof origin !== 'string' || !/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev$/.test(origin)) {
  process.stderr.write('Set RECRUITING_SANDBOX_PUBLIC_ORIGIN to the synthetic Recruiting Workers.dev origin.\n');
  process.exitCode = 64;
} else {
  const cookieFrom = (response, name) => {
    const value = response.headers.get('set-cookie') ?? '';
    return value.match(new RegExp(`${name}=([^;,]+)`))?.[1] ?? null;
  };
  async function connect(from = 'report') {
    const startPath = from === 'report'
      ? `/auth/connected/start?from=report&vacancy_id=${vacancyId}&candidate_id=${candidateId}`
      : '/auth/connected/start?from=proactive&vacancy_id=vac_demo_001';
    const start = await fetch(`${origin}${startPath}`, { redirect: 'manual' });
    if (start.status !== 303) throw new Error(`report_auth_start_${start.status}`);
    const pending = cookieFrom(start, '__Host-recruiting-oauth-pending');
    if (!pending) throw new Error('report_auth_pending_cookie_missing');
    const authorizeUrl = new URL(start.headers.get('location'));
    if (authorizeUrl.origin !== origin) throw new Error('report_auth_origin_invalid');
    const authorize = await fetch(authorizeUrl, { redirect: 'manual', headers: { cookie: `__Host-recruiting-oauth-pending=${pending}` } });
    if (authorize.status !== 303) throw new Error(`report_synthetic_authorize_${authorize.status}`);
    const callback = new URL(authorize.headers.get('location'));
    if (callback.origin !== origin) throw new Error('report_auth_callback_origin_invalid');
    const completed = await fetch(callback, { redirect: 'manual', headers: { cookie: `__Host-recruiting-oauth-pending=${pending}` } });
    if (completed.status !== 303) throw new Error(`report_auth_callback_${completed.status}`);
    const session = cookieFrom(completed, '__Host-recruiting-app-session');
    if (!session) throw new Error('report_auth_session_cookie_missing');
    const sessionCookie = `__Host-recruiting-app-session=${session}`;
    const sessionResponse = await fetch(`${origin}/auth/connected/session`, { headers: { cookie: sessionCookie } });
    if (!sessionResponse.ok) throw new Error(`report_auth_session_${sessionResponse.status}`);
    const body = await sessionResponse.json();
    const requiredScopes = from === 'report'
      ? ['recruiting.reports.read', 'recruiting.reports.create', 'recruiting.reports.edit', 'recruiting.reports.review']
      : ['recruiting.candidateSearch'];
    if (!Array.isArray(body.scopes) || !requiredScopes.every(scope => body.scopes.includes(scope)))
      throw new Error('report_auth_scopes_incomplete');
    return { cookie: sessionCookie, csrfToken: body.csrfToken };
  }

  try {
    const sandboxLogin = await fetch(`${origin}/__sandbox-login`, { redirect: 'manual' });
    if (sandboxLogin.status !== 303 || !/from=proactive/.test(sandboxLogin.headers.get('location') ?? ''))
      throw new Error(`sandbox_login_${sandboxLogin.status}`);
    const recruiter = await connect('proactive');
    const morningPage = await fetch(`${origin}/hh/proactive?vacancy_id=vac_demo_001`, {
      headers: { cookie: recruiter.cookie },
    });
    const morningHtml = await morningPage.text();
    if (!morningPage.ok || !morningHtml.includes('/hh/candidate-report?vacancy_id=vac_demo_001&amp;candidate_id=candidate_search_demo_001'))
      throw new Error(`morning_page_${morningPage.status}`);
    const manualSearch = await fetch(`${origin}/api/hh/proactive/search`, { method: 'POST',
      headers: { cookie: recruiter.cookie, origin, 'x-csrf-token': recruiter.csrfToken,
        'content-type': 'application/json', 'Idempotency-Key': `sandbox-search-${randomUUID()}` },
      body: JSON.stringify({ vacancy_id: 'vac_demo_001' }),
    });
    if (!manualSearch.ok) throw new Error(`candidate_search_${manualSearch.status}`);
    const candidateResponse = await fetch(`${origin}/api/hh/proactive/candidates?vacancy_id=vac_demo_001`, {
      headers: { cookie: recruiter.cookie },
    });
    if (!candidateResponse.ok) throw new Error(`candidate_feed_${candidateResponse.status}`);
    const candidateFeed = await candidateResponse.json();
    if (!Array.isArray(candidateFeed.candidates) ||
        !candidateFeed.candidates.some(candidate => candidate.candidateRef === candidateId))
      throw new Error('candidate_feed_empty');

    const pageUrl = `${origin}/hh/candidate-report?vacancy_id=${vacancyId}&candidate_id=${candidateId}`;
    const entry = await fetch(pageUrl, { redirect: 'manual' });
    if (entry.status !== 303) throw new Error(`report_page_step_up_${entry.status}`);
    const owner = await connect();
    const page = await fetch(pageUrl, { headers: { cookie: owner.cookie } });
    if (!page.ok || !(await page.text()).includes('Черновик отчёта кандидата'))
      throw new Error(`report_page_${page.status}`);
    const sourceUrl = new URL('/api/v1/ui/accepted-report-client-source', origin);
    sourceUrl.searchParams.set('candidateId', candidateId);
    sourceUrl.searchParams.set('vacancyId', vacancyId);
    const sourceResponse = await fetch(sourceUrl, { headers: { cookie: owner.cookie } });
    if (!sourceResponse.ok) throw new Error(`report_source_${sourceResponse.status}`);
    const source = await sourceResponse.json();
    if (source.clientDraftFields?.candidateName !== 'Синтетический кандидат' ||
        JSON.stringify(source).includes('@') || JSON.stringify(source).includes('hh.ru'))
      throw new Error('report_source_not_synthetic_or_not_projected');
    const headers = { cookie: owner.cookie, origin, 'x-csrf-token': owner.csrfToken,
      'content-type': 'application/json' };
    const createdResponse = await fetch(`${origin}/api/v1/ui/accepted-report-drafts`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': `sandbox-report-${randomUUID()}` },
      body: JSON.stringify({ candidateId, vacancyId, expectedSourceRevision: source.sourceRevision,
        expectedPolicyRevision: 0 }),
    });
    if (createdResponse.status !== 201) throw new Error(`report_create_${createdResponse.status}`);
    const draft = await createdResponse.json();
    const preview = await fetch(`${origin}/api/v1/ui/accepted-report-drafts/${draft.reportRef}/preview`, {
      headers: { cookie: owner.cookie },
    });
    if (!preview.ok || !(await preview.text()).includes('Синтетический кандидат'))
      throw new Error(`report_preview_${preview.status}`);
    const approvedResponse = await fetch(`${origin}/api/v1/ui/accepted-report-drafts/${draft.reportRef}/review`, {
      method: 'POST', headers,
      body: JSON.stringify({ expectedReportRevision: draft.reportRevision, decision: 'approved' }),
    });
    if (!approvedResponse.ok) throw new Error(`report_review_${approvedResponse.status}`);
    const approved = await approvedResponse.json();
    const exported = await fetch(`${origin}/api/v1/ui/accepted-report-drafts/${draft.reportRef}/export`, {
      method: 'POST', headers,
      body: JSON.stringify({ expectedReportRevision: approved.reportRevision }),
    });
    const exportCache = exported.headers.get('cache-control') ?? '';
    const exportDisposition = exported.headers.get('content-disposition') ?? '';
    const exportBody = await exported.text();
    const attachmentSafe = /attachment; filename="candidate-report-report_[a-f0-9]{32}\.html"/.test(exportDisposition);
    const hasFixture = exportBody.includes('Синтетический кандидат');
    if (!exported.ok || !/private, no-store/.test(exportCache) || !attachmentSafe || !hasFixture)
      throw new Error(`report_export_${exported.status}_cache=${/private, no-store/.test(exportCache)}_attachment=${attachmentSafe}_fixture=${hasFixture}`);
    const other = await connect();
    const foreign = await fetch(`${origin}/api/v1/ui/accepted-report-drafts/${draft.reportRef}`, {
      headers: { cookie: other.cookie },
    });
    if (foreign.status !== 404) throw new Error(`report_cross_profile_${foreign.status}`);
    process.stdout.write(JSON.stringify({ result: 'PASS', environment: 'synthetic-sandbox',
      morningPage: morningPage.status, morningCandidates: candidateFeed.candidates.length,
      reportPage: page.status, acceptedSource: sourceResponse.status, draft: createdResponse.status,
      preview: preview.status, review: approvedResponse.status, export: exported.status,
      crossProfileRead: foreign.status }) + '\n');
  } catch (error) {
    process.stderr.write(`Synthetic accepted-report sandbox probe failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
