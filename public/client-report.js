const statusNode = document.querySelector('#status');
const summaryNode = document.querySelector('#source-summary');
const revisionNode = document.querySelector('#source-revision');
const previewNode = document.querySelector('#preview');
const positionNode = document.querySelector('#position');
const vacancyTitleNode = document.querySelector('#vacancy-title');
const summaryNodeEditor = document.querySelector('#summary');
const conclusionNode = document.querySelector('#conclusion');
const experienceNode = document.querySelector('#experience-editor');
const fitNode = document.querySelector('#fit-editor');
const addExperienceButton = document.querySelector('#add-experience');
const addFitButton = document.querySelector('#add-fit');
const saveEditsButton = document.querySelector('#save-edits');
const approvalNode = document.querySelector('#approval');
const approveButton = document.querySelector('#approve');
const requestChangesButton = document.querySelector('#request-changes');
const policyListNode = document.querySelector('#policy-list');
const policyPhraseNode = document.querySelector('#policy-phrase');
const addPolicyPhraseButton = document.querySelector('#add-policy-phrase');
const params = new URLSearchParams(location.search);
const candidateId = params.get('candidate_id');
const vacancyId = params.get('vacancy_id');
const sourceKind = params.get('source_kind') ?? 'accepted_cold_search';
let report = null;
let policy = null;
let csrfToken = null;

function showStatus(text) { statusNode.textContent = text; }
async function request(path, options = {}) {
  return fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options,
    headers: { ...(options.headers ?? {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) } });
}
function reportError(response, payload) {
  const known = {
    stale_report_source: 'Источник изменился. Откройте кандидата заново и создайте новый черновик.',
    stale_report_policy: 'Ограничения отчёта изменились. Обновите страницу перед продолжением.',
    report_policy_violation: `Черновик содержит запретную формулировку в полях: ${(payload?.violations ?? []).map(item => item.fieldPath).join(', ')}. Исправьте ограничения или источник и откройте отчёт заново.`,
    connected_app_introspection_unavailable: 'Проверка профиля временно недоступна.',
    report_source_unavailable: 'Не удалось проверить источник кандидата.',
    not_found: 'Кандидат или черновик не найден для выбранного профиля.',
    report_scope_required: 'У профиля нет нужного доступа к отчётам.',
    stale_report_revision: 'Черновик изменился в другой вкладке. Перезагрузите его перед правкой.',
    report_not_editable: 'Этот черновик уже подтверждён и больше не редактируется.',
  };
  return known[payload?.error] ?? `Запрос не выполнен (${response.status}).`;
}

function policyRevisionNumber() { return Number(String(policy?.policyRevision ?? 'policy-r0').replace(/^policy-r/, '')); }
function renderPolicy() {
  policyListNode.replaceChildren();
  for (const [index, phrase] of (policy?.forbiddenPhrases ?? []).entries()) {
    const item = document.createElement('li'); item.append(document.createTextNode(phrase + ' '));
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Убрать';
    remove.addEventListener('click', () => savePolicy(policy.forbiddenPhrases.filter((_, i) => i !== index)));
    item.append(remove); policyListNode.append(item);
  }
}

async function savePolicy(forbiddenPhrases) {
  if (!policy || forbiddenPhrases.length > 50) return;
  addPolicyPhraseButton.disabled = true;
  try {
    const response = await request('/api/v1/ui/accepted-report-policy', { method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateId, vacancyId, sourceKind,
        expectedPolicyRevision: policyRevisionNumber(), policy: { forbiddenPhrases } }) });
    const result = await response.json();
    if (!response.ok) { showStatus(reportError(response, result)); addPolicyPhraseButton.disabled = false; return; }
    policy = result; renderPolicy(); policyPhraseNode.value = '';
    showStatus('Ограничения сохранены. Проверяю источник и открываю черновик с новой ревизией правил…');
    await load();
  } catch { showStatus('Не удалось сохранить ограничения отчёта.'); addPolicyPhraseButton.disabled = false; }
}

function experienceRow(value = { role: '', company: '', period: '' }) {
  const fieldset = document.createElement('fieldset');
  for (const [key, title] of [['role', 'Должность'], ['company', 'Компания'], ['period', 'Период']]) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement('input'); input.maxLength = 500; input.required = true;
    input.dataset.experienceField = key; input.value = value[key] ?? '';
    label.append(input); fieldset.append(label);
  }
  const details = document.createElement('textarea'); details.maxLength = 5000; details.rows = 3;
  details.dataset.experienceDetails = 'true'; details.placeholder = 'Обязанности и результаты, по одному на строку';
  details.value = (value.details ?? []).join('\n'); fieldset.append(details);
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Убрать место работы';
  remove.addEventListener('click', () => { fieldset.remove(); saveEditsButton.disabled = false; });
  fieldset.append(remove); experienceNode.append(fieldset);
}

function fitRow(value = { requirement: '', status: 'partial', comment: '' }) {
  const fieldset = document.createElement('fieldset');
  const requirement = document.createElement('input'); requirement.maxLength = 300; requirement.required = true;
  requirement.dataset.fitField = 'requirement'; requirement.placeholder = 'Требование'; requirement.value = value.requirement ?? '';
  const status = document.createElement('select'); status.dataset.fitField = 'status';
  for (const [key, title] of [['yes', 'Соответствует'], ['partial', 'Частично / неясно'], ['no', 'Не соответствует']]) {
    const option = document.createElement('option'); option.value = key; option.textContent = title; status.append(option);
  }
  status.value = value.status ?? 'partial';
  const comment = document.createElement('textarea'); comment.maxLength = 1000; comment.rows = 2;
  comment.dataset.fitField = 'comment'; comment.placeholder = 'Подтверждённые сведения или причина неопределённости'; comment.value = value.comment ?? '';
  fieldset.append(requirement, status, comment);
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Убрать требование';
  remove.addEventListener('click', () => { fieldset.remove(); saveEditsButton.disabled = false; });
  fieldset.append(remove); fitNode.append(fieldset);
}

function renderEditor(fields) {
  summaryNodeEditor.value = fields.summary ?? '';
  conclusionNode.value = fields.conclusion ?? '';
  positionNode.value = fields.position;
  vacancyTitleNode.value = fields.vacancyTitle;
  experienceNode.replaceChildren();
  for (const item of fields.experience) experienceRow(item);
  fitNode.replaceChildren();
  for (const item of (fields.fit ?? [])) fitRow(item);
  saveEditsButton.disabled = true;
}

function setEditorEnabled(enabled) {
  positionNode.disabled = !enabled; vacancyTitleNode.disabled = !enabled;
  summaryNodeEditor.disabled = !enabled; conclusionNode.disabled = !enabled;
  experienceNode.querySelectorAll('input,textarea,button').forEach(node => { node.disabled = !enabled; });
  fitNode.querySelectorAll('input,select,textarea,button').forEach(node => { node.disabled = !enabled; });
  addExperienceButton.disabled = !enabled;
  addFitButton.disabled = !enabled;
  if (!enabled) saveEditsButton.disabled = true;
}

function syncReviewControls() {
  const approved = report?.reviewState === 'approved';
  approvalNode.disabled = approved;
  approveButton.disabled = approved || !approvalNode.checked;
  requestChangesButton.disabled = approved ? false : !approvalNode.checked;
}

function editedFields() {
  return { position: positionNode.value.trim(), vacancyTitle: vacancyTitleNode.value.trim(),
    summary: summaryNodeEditor.value.trim(), conclusion: conclusionNode.value.trim(),
    experience: [...experienceNode.querySelectorAll('fieldset')].map(row => Object.fromEntries(
      [...row.querySelectorAll('[data-experience-field]')].map(input => [input.dataset.experienceField, input.value.trim()])).concat([
        ['details', [...row.querySelector('[data-experience-details]').value.split('\n')].map(item => item.trim()).filter(Boolean)]
      ])),
    fit: [...fitNode.querySelectorAll('fieldset')].map(row => Object.fromEntries(
      [...row.querySelectorAll('[data-fit-field]')].map(input => [input.dataset.fitField, input.value.trim()]))) };
}

async function refreshPreview() {
  const response = await request(`/api/v1/ui/accepted-report-drafts/${encodeURIComponent(report.reportRef)}/preview`);
  const preview = await response.json();
  if (!response.ok) { showStatus(reportError(response, preview)); return false; }
  previewNode.srcdoc = preview.html;
  return true;
}

async function load() {
  if (!candidateId || !vacancyId || !['accepted_cold_search', 'accepted_hh_response'].includes(sourceKind) ||
      ![2, 3].includes(params.size) || [...params.keys()].some(key => !['candidate_id', 'vacancy_id', 'source_kind'].includes(key))) {
    showStatus('Некорректная ссылка на кандидата.'); return;
  }
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
    sourceUrl.searchParams.set('sourceKind', sourceKind);
    const sourceResponse = await request(sourceUrl.pathname + sourceUrl.search);
    const source = await sourceResponse.json();
    if (!sourceResponse.ok) { showStatus(reportError(sourceResponse, source)); return; }
    summaryNode.textContent = `${source.clientDraftFields.candidateName} · ${source.clientDraftFields.position} · ${source.clientDraftFields.vacancyTitle}`;
    revisionNode.textContent = `Ревизия принятого источника: ${source.sourceRevision}`;
    const policyUrl = new URL('/api/v1/ui/accepted-report-policy', location.origin);
    policyUrl.searchParams.set('candidateId', candidateId);
    policyUrl.searchParams.set('vacancyId', vacancyId);
    policyUrl.searchParams.set('sourceKind', sourceKind);
    const policyResponse = await request(policyUrl.pathname + policyUrl.search);
    policy = await policyResponse.json();
    if (!policyResponse.ok) { showStatus(reportError(policyResponse, policy)); return; }
    addPolicyPhraseButton.disabled = false; renderPolicy();
    const policyRevision = policyRevisionNumber();
    const key = `r04:${source.sourceRevision}:p${policyRevision}`;
    const createResponse = await request('/api/v1/ui/accepted-report-drafts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ candidateId, vacancyId, sourceKind, expectedSourceRevision: source.sourceRevision,
        expectedPolicyRevision: policyRevision }),
    });
    report = await createResponse.json();
    if (!createResponse.ok) { showStatus(reportError(createResponse, report)); return; }
    if (!await refreshPreview()) return;
    renderEditor(report.clientFields);
    setEditorEnabled(report.reviewState !== 'approved');
    showStatus(report.reviewState === 'approved'
      ? 'Вы уже подтвердили проверку этого черновика.'
      : 'Проверьте предпросмотр. Подтверждение фиксирует только вашу проверку и не отправляет отчёт клиенту.');
    syncReviewControls();
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
    syncReviewControls();
    setEditorEnabled(false);
    showStatus('Проверка сохранена. Отчёт остался приватным черновиком и не отправлен.');
  } catch {
    showStatus('Не удалось сохранить отметку проверки. Черновик не отправлялся.');
    approveButton.disabled = false;
  }
});

requestChangesButton.addEventListener('click', async () => {
  if (!report || (!approvalNode.checked && report.reviewState !== 'approved')) {
    showStatus('Сначала подтвердите, что вы проверили предпросмотр.'); return;
  }
  requestChangesButton.disabled = true;
  try {
    const response = await request(`/api/v1/ui/accepted-report-drafts/${encodeURIComponent(report.reportRef)}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'changes_requested', expectedReportRevision: report.reportRevision }),
    });
    const result = await response.json();
    if (!response.ok) { showStatus(reportError(response, result)); syncReviewControls(); return; }
    report = result; approvalNode.checked = false; syncReviewControls(); setEditorEnabled(true);
    showStatus('Черновик возвращён на исправление. После правок нужно просмотреть и подтвердить новую версию.');
  } catch { showStatus('Не удалось вернуть черновик на исправление.'); syncReviewControls(); }
});

approvalNode.addEventListener('change', syncReviewControls);

addExperienceButton.addEventListener('click', () => {
  if (experienceNode.querySelectorAll('fieldset').length >= 5) { showStatus('Можно указать не более пяти мест работы.'); return; }
  experienceRow(); saveEditsButton.disabled = false;
});

addFitButton.addEventListener('click', () => {
  if (fitNode.querySelectorAll('fieldset').length >= 20) { showStatus('Можно указать не более двадцати требований.'); return; }
  fitRow(); saveEditsButton.disabled = false;
});

addPolicyPhraseButton.addEventListener('click', async () => {
  const phrase = policyPhraseNode.value.trim();
  if (!phrase) { showStatus('Введите точную запретную фразу.'); return; }
  await savePolicy([...policy.forbiddenPhrases, phrase]);
});
positionNode.addEventListener('input', () => { saveEditsButton.disabled = false; });
vacancyTitleNode.addEventListener('input', () => { saveEditsButton.disabled = false; });
experienceNode.addEventListener('input', () => { saveEditsButton.disabled = false; });
fitNode.addEventListener('input', () => { saveEditsButton.disabled = false; });
fitNode.addEventListener('change', () => { saveEditsButton.disabled = false; });
summaryNodeEditor.addEventListener('input', () => { saveEditsButton.disabled = false; });
conclusionNode.addEventListener('input', () => { saveEditsButton.disabled = false; });

saveEditsButton.addEventListener('click', async () => {
  if (!report || report.reviewState === 'approved') return;
  saveEditsButton.disabled = true;
  try {
    const response = await request(`/api/v1/ui/accepted-report-drafts/${encodeURIComponent(report.reportRef)}/edit`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedReportRevision: report.reportRevision, clientFields: editedFields() }),
    });
    const result = await response.json();
    if (!response.ok) { showStatus(reportError(response, result)); saveEditsButton.disabled = false; return; }
    report = result; approvalNode.checked = false; syncReviewControls();
    setEditorEnabled(true);
    if (!await refreshPreview()) return;
    showStatus('Изменения сохранены. Просмотрите обновлённый клиентский вид перед внутренним подтверждением.');
  } catch { showStatus('Не удалось сохранить правки. Черновик остался приватным.'); saveEditsButton.disabled = false; }
});

load();
