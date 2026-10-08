const statusNode = document.querySelector('#status');
const summaryNode = document.querySelector('#source-summary');
const revisionNode = document.querySelector('#source-revision');
const previewNode = document.querySelector('#preview');
const approvalNode = document.querySelector('#approval');
const approveButton = document.querySelector('#approve');
const params = new URLSearchParams(location.search);
const candidateId = params.get('candidate_id');
const vacancyId = params.get('vacancy_id');
let report = null;
let csrfToken = null;

function showStatus(text) { statusNode.textContent = text; }
async function request(path, options = {}) {
  return fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options,
    headers: { ...(options.headers ?? {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) } });
}
function reportError(response, payload) {
  const known = {
    stale_report_source: 'Источник изменился. Откройте кандидата заново и создайте новый черновик.',
    connected_app_introspection_unavailable: 'Проверка профиля временно недоступна.',
    report_source_unavailable: 'Не удалось проверить источник кандидата.',
    not_found: 'Кандидат или черновик не найден для выбранного профиля.',
    report_scope_required: 'У профиля нет нужного доступа к отчётам.',
  };
  return known[payload?.error] ?? `Запрос не выполнен (${response.status}).`;
}

async function load() {
  if (!candidateId || !vacancyId || params.size !== 2) { showStatus('Некорректная ссылка на кандидата.'); return; }
  try {
    const sessionResponse = await request('/auth/connected/session');
    const session = await sessionResponse.json();
    if (!sessionResponse.ok || !session.authenticated || typeof session.csrfToken !== 'string') {
      showStatus('Сессия профиля завершилась. Перейдите в приложение и откройте отчёт снова.'); return;
    }
    csrfToken = session.csrfToken;
    const sourceUrl = new URL('/api/v1/ui/accepted-report-client-source', location.origin);
    sourceUrl.searchParams.set('candidateId', candidateId);
    sourceUrl.searchParams.set('vacancyId', vacancyId);
    const sourceResponse = await request(sourceUrl.pathname + sourceUrl.search);
    const source = await sourceResponse.json();
    if (!sourceResponse.ok) { showStatus(reportError(sourceResponse, source)); return; }
    summaryNode.textContent = `${source.clientDraftFields.candidateName} · ${source.clientDraftFields.position} · ${source.clientDraftFields.vacancyTitle}`;
    revisionNode.textContent = `Ревизия принятого источника: ${source.sourceRevision}`;
    const key = `r04:${source.sourceRevision}`;
    const createResponse = await request('/api/v1/ui/accepted-report-drafts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ candidateId, vacancyId, expectedSourceRevision: source.sourceRevision }),
    });
    report = await createResponse.json();
    if (!createResponse.ok) { showStatus(reportError(createResponse, report)); return; }
    const previewResponse = await request(`/api/v1/ui/accepted-report-drafts/${encodeURIComponent(report.reportRef)}/preview`);
    const preview = await previewResponse.json();
    if (!previewResponse.ok) { showStatus(reportError(previewResponse, preview)); return; }
    previewNode.srcdoc = preview.html;
    showStatus(report.reviewState === 'approved'
      ? 'Вы уже подтвердили проверку этого черновика.'
      : 'Проверьте предпросмотр. Подтверждение фиксирует только вашу проверку и не отправляет отчёт клиенту.');
    approvalNode.disabled = report.reviewState === 'approved';
    approveButton.disabled = report.reviewState === 'approved';
  } catch {
    showStatus('Не удалось загрузить черновик. Попробуйте ещё раз после восстановления соединения.');
  }
}

approveButton.addEventListener('click', async () => {
  if (!report || !approvalNode.checked) { showStatus('Сначала отметьте, что проверили предпросмотр.'); return; }
  approveButton.disabled = true;
  try {
    const response = await request(`/api/v1/ui/accepted-report-drafts/${encodeURIComponent(report.reportRef)}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', expectedReportRevision: report.reportRevision }),
    });
    const result = await response.json();
    if (!response.ok) { showStatus(reportError(response, result)); approveButton.disabled = false; return; }
    report = result;
    approvalNode.disabled = true;
    showStatus('Проверка сохранена. Отчёт остался приватным черновиком и не отправлен.');
  } catch {
    showStatus('Не удалось сохранить отметку проверки. Черновик не отправлялся.');
    approveButton.disabled = false;
  }
});

load();
