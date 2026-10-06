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
const fieldProvenanceNode = document.querySelector('#field-provenance');
const regenerateButton = document.querySelector('#regenerate-report');
const replaceEditedFieldsNode = document.querySelector('#replace-edited-fields');
const addExperienceButton = document.querySelector('#add-experience');
const addFitButton = document.querySelector('#add-fit');
const saveEditsButton = document.querySelector('#save-edits');
const approvalNode = document.querySelector('#approval');
const approveButton = document.querySelector('#approve');
const requestChangesButton = document.querySelector('#request-changes');
const policyListNode = document.querySelector('#policy-list');
const policyPhraseNode = document.querySelector('#policy-phrase');
const addPolicyPhraseButton = document.querySelector('#add-policy-phrase');
const instructionSection = document.querySelector('#instructions-section');
const instructionScopeNode = document.querySelector('#instruction-scope');
const instructionIncludeNode = document.querySelector('#instruction-include');
const instructionStyleNode = document.querySelector('#instruction-style');
const instructionRecruiterNode = document.querySelector('#instruction-recruiter');
const instructionSummaryNode = document.querySelector('#effective-instructions');
const instructionStatusNode = document.querySelector('#instructions-status');
const instructionHistoryNode = document.querySelector('#instruction-history-list');
const saveInstructionsButton = document.querySelector('#save-instructions');
const params = new URLSearchParams(location.search);
const candidateId = params.get('candidate_id');
const vacancyId = params.get('vacancy_id');
const sourceKind = params.get('source_kind') ?? 'accepted_cold_search';
let report = null;
let policy = null;
let reportInstructions = null;
let displayedInstructionScope = null;
const instructionDrafts = new Map();
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
    report_generator_unavailable: 'Составитель отчётов сейчас недоступен. Черновик не менялся.',
    report_generation_invalid: 'Составитель вернул неподдерживаемый формат. Черновик не менялся.',
    stale_report_instructions: 'Инструкции изменились во время составления. Повторите после обновления страницы.',
    report_has_no_fields_to_regenerate: 'Все доступные поля сохранены как ваши ручные правки. Снимите отметку, если хотите заменить их.',
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

function renderFieldProvenance(value = {}) {
  fieldProvenanceNode.replaceChildren();
  const title = document.createElement('strong'); title.textContent = 'Источник полей: '; fieldProvenanceNode.append(title);
  const labels = { candidateName: 'имя', position: 'должность', vacancyTitle: 'вакансия',
    experience: 'опыт', summary: 'краткое описание', fit: 'соответствие требованиям', conclusion: 'вывод' };
  const kinds = { source: 'принятый источник', recruiter: 'правка рекрутера', generated: 'сформировано' };
  const entries = Object.entries(value);
  if (!entries.length) { fieldProvenanceNode.append(document.createTextNode('источник ещё не указан')); return; }
  entries.forEach(([field, provenance], index) => {
    if (index) fieldProvenanceNode.append(document.createTextNode(' · '));
    const item = document.createElement('span');
    item.textContent = `${labels[field] ?? field}: ${kinds[provenance.kind] ?? 'неизвестно'}`;
    fieldProvenanceNode.append(item);
  });
}

const instructionFields = [
  ['includeGuidance', instructionIncludeNode], ['styleGuidance', instructionStyleNode],
  ['recruiterNotes', instructionRecruiterNode],
];
const scopeTitles = { profile: 'Профиль', vacancy: 'Вакансия', candidate: 'Кандидат', report_version: 'Версия отчёта' };
function lines(value) { return value.split('\n').map(item => item.trim()).filter(Boolean); }
function renderEffectiveInstructions() {
  instructionSummaryNode.replaceChildren();
  const shown = reportInstructions?.provenance ?? [];
  if (!shown.length) { instructionSummaryNode.textContent = 'Для выбранных областей сохранённых инструкций пока нет.'; return; }
  for (const entry of shown) {
    const row = document.createElement('p');
    const source = `${scopeTitles[entry.scopeType]} · ревизия ${entry.revision}`;
    row.textContent = `${source}: ${entry.text}`;
    instructionSummaryNode.append(row);
  }
}
function renderInstructionEditor() {
  displayedInstructionScope = instructionScopeNode.value;
  const scope = reportInstructions?.scopes.find(item => item.scopeType === instructionScopeNode.value);
  const value = instructionDrafts.get(instructionScopeNode.value) ?? scope?.instructions ??
    { includeGuidance: [], styleGuidance: [], recruiterNotes: [] };
  for (const [key, node] of instructionFields) node.value = value[key].join('\n');
  instructionHistoryNode.replaceChildren();
  const history = (scope?.history ?? []).slice(-10).reverse();
  for (const entry of history) {
    const row = document.createElement('li');
    const detail = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Ревизия ${entry.revision} · ${entry.updatedAt}`; detail.append(summary);
    for (const [key, node] of instructionFields) {
      if (!entry.instructions[key].length) continue;
      const heading = document.createElement('h4'); heading.textContent = key === 'includeGuidance' ? 'Что включать'
        : key === 'styleGuidance' ? 'Стиль' : 'Заметки рекрутера'; detail.append(heading);
      const list = document.createElement('ul');
      for (const text of entry.instructions[key]) { const item = document.createElement('li'); item.textContent = text; list.append(item); }
      detail.append(list);
    }
    row.append(detail); instructionHistoryNode.append(row);
  }
  saveInstructionsButton.disabled = false;
  syncReviewControls();
}
function storeCurrentInstructionDraft() {
  if (!reportInstructions || !displayedInstructionScope) return;
  instructionDrafts.set(displayedInstructionScope,
    Object.fromEntries(instructionFields.map(([key, node]) => [key, lines(node.value)])));
}
function hasUnsavedInstructionChanges() {
  return [...instructionDrafts.entries()].some(([scopeType, instructions]) => {
    const saved = reportInstructions?.scopes.find(item => item.scopeType === scopeType)?.instructions ??
      { includeGuidance: [], styleGuidance: [], recruiterNotes: [] };
    return JSON.stringify(instructions) !== JSON.stringify(saved);
  });
}
async function loadReportInstructions() {
  instructionSection.hidden = false;
  instructionStatusNode.textContent = 'Загружаю инструкции по выбранному профилю, вакансии и кандидату…';
  saveInstructionsButton.disabled = true;
  const query = new URLSearchParams({ candidateId, vacancyId, sourceKind,
    reportRef: report.reportRef, reportRevision: report.reportRevision });
  const response = await request(`/api/v1/ui/accepted-report-instructions?${query}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error ?? 'report_instructions_unavailable');
  reportInstructions = result;
  renderEffectiveInstructions();
  renderInstructionEditor();
  instructionStatusNode.textContent = 'Инструкции загружены. Профиль → вакансия → кандидат → версия отчёта.';
}

async function saveReportInstructions() {
  if (!report || !reportInstructions) return;
  const scopeType = instructionScopeNode.value;
  const scope = reportInstructions.scopes.find(item => item.scopeType === scopeType);
  const instructions = Object.fromEntries(instructionFields.map(([key, node]) => [key, lines(node.value)]));
  const totalLength = Object.values(instructions).flat().reduce((total, item) => total + item.length, 0);
  if (Object.values(instructions).some(list => list.length > 30 || list.some(item => item.length > 1000)) || totalLength > 8000) {
    instructionStatusNode.textContent = 'Не больше 30 строк в каждом разделе, до 1000 символов на строку и до 8000 символов на область.'; return;
  }
  saveInstructionsButton.disabled = true;
  instructionStatusNode.textContent = 'Сохраняю новую ревизию…';
  try {
    const response = await request('/api/v1/ui/accepted-report-instructions', { method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateId, vacancyId, sourceKind, scopeType,
        expectedRevision: scope.revision, instructions,
        ...(scopeType === 'report_version' ? { reportRef: report.reportRef, reportRevision: report.reportRevision } : {}) }) });
    const result = await response.json();
    if (!response.ok) {
      instructionStatusNode.textContent = result?.error === 'stale_report_instructions'
        ? 'Инструкции изменились в другой вкладке. Перезагрузите страницу.'
        : `Не удалось сохранить инструкции (${response.status}).`;
      saveInstructionsButton.disabled = false; return;
    }
    instructionDrafts.delete(scopeType);
    await loadReportInstructions();
    instructionStatusNode.textContent = 'Инструкции сохранены; предыдущие ревизии доступны в истории выбранной области.';
  } catch {
    instructionStatusNode.textContent = 'Связь недоступна. Инструкции не сохранены.';
    saveInstructionsButton.disabled = false;
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
  regenerateButton.disabled = approved || hasUnsavedInstructionChanges();
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

regenerateButton.addEventListener('click', async () => {
  if (!report || report.reviewState === 'approved') return;
  if (hasUnsavedInstructionChanges()) { showStatus('Сначала сохраните или удалите несохранённые инструкции.'); return; }
  regenerateButton.disabled = true;
  showStatus('Составляю текст по принятому источнику и сохранённым инструкциям…');
  try {
    const response = await request(`/api/v1/ui/accepted-report-drafts/${encodeURIComponent(report.reportRef)}/regenerate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedReportRevision: report.reportRevision,
        replaceRecruiterEditedFields: replaceEditedFieldsNode.checked }),
    });
    const result = await response.json();
    if (!response.ok) { showStatus(reportError(response, result)); regenerateButton.disabled = false; return; }
    report = result; approvalNode.checked = false; instructionDrafts.delete('report_version');
    await loadReportInstructions(); syncReviewControls();
    renderEditor(report.clientFields); renderFieldProvenance(report.fieldProvenance);
    setEditorEnabled(true);
    if (!await refreshPreview()) return;
    showStatus('Новая ревизия составлена. Проверьте каждое поле и предпросмотр; версия остаётся приватным черновиком.');
  } catch {
    showStatus('Не удалось связаться с составителем. Черновик не менялся.'); regenerateButton.disabled = false;
  }
});

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
    try { await loadReportInstructions(); }
    catch { instructionSection.hidden = false; instructionStatusNode.textContent = 'Не удалось загрузить инструкции. Проверьте соединение перед оформлением отчёта.'; }
    if (!await refreshPreview()) return;
    renderEditor(report.clientFields);
    renderFieldProvenance(report.fieldProvenance);
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
    instructionDrafts.delete('report_version'); await loadReportInstructions();
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
    report = result; approvalNode.checked = false; instructionDrafts.delete('report_version');
    await loadReportInstructions(); syncReviewControls(); setEditorEnabled(true);
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
    report = result; approvalNode.checked = false; instructionDrafts.delete('report_version');
    await loadReportInstructions(); syncReviewControls();
    renderFieldProvenance(report.fieldProvenance);
    setEditorEnabled(true);
    if (!await refreshPreview()) return;
    showStatus('Изменения сохранены. Просмотрите обновлённый клиентский вид перед внутренним подтверждением.');
  } catch { showStatus('Не удалось сохранить правки. Черновик остался приватным.'); saveEditsButton.disabled = false; }
});
instructionScopeNode.addEventListener('change', () => { storeCurrentInstructionDraft(); renderInstructionEditor(); });
for (const [, node] of instructionFields) node.addEventListener('input', () => {
  storeCurrentInstructionDraft(); saveInstructionsButton.disabled = false; syncReviewControls();
});
saveInstructionsButton.addEventListener('click', saveReportInstructions);

load();
