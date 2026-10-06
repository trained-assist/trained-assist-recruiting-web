const form = document.querySelector('#assignment-review');
if (form) {
  const stagesRoot = document.querySelector('#assignment-stages');
  const status = document.querySelector('#assignment-save-status');
  const escapeText = value => String(value ?? '');
  let plan;
  try { plan = JSON.parse(stagesRoot.dataset.plan); }
  catch { plan = null; }

  function field(stage, key, label, multiline = false) {
    const wrapper = document.createElement('p');
    const id = `stage-${stage.id}-${key}`;
    const caption = document.createElement('label');
    caption.htmlFor = id;
    caption.textContent = label;
    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.id = id;
    input.name = key;
    if (!multiline) input.type = 'text';
    input.value = escapeText(stage[key]);
    input.required = key === 'title' || key === 'instruction';
    input.maxLength = key === 'material' || key === 'instruction' ? 16000 : 2000;
    wrapper.append(caption, input);
    return wrapper;
  }

  function renderStages() {
    stagesRoot.replaceChildren();
    for (const [index, stage] of plan.stages.entries()) {
      const section = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = `Этап ${index + 1}`;
      section.append(legend, field(stage, 'title', 'Название'), field(stage, 'instruction', 'Инструкция', true),
        field(stage, 'completion_result', 'Ожидаемый результат', true), field(stage, 'material', 'Дословный материал', true));
      const modeLabel = document.createElement('label');
      modeLabel.textContent = 'Тип материала';
      const mode = document.createElement('select');
      mode.name = 'material_mode';
      for (const [value, text] of [['verbatim', 'Дословный текст'], ['context', 'Контекст']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = text;
        option.selected = stage.material_mode === value; mode.append(option);
      }
      modeLabel.append(mode); section.append(modeLabel);
      if (index > 0) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Удалить этап';
        remove.addEventListener('click', () => { syncStagesFromForm(); plan.stages.splice(index, 1); renderStages(); });
        section.append(remove);
      }
      stagesRoot.append(section);
    }
  }

  function syncStagesFromForm() {
    for (const [index, section] of [...stagesRoot.querySelectorAll('fieldset')].entries()) {
      const stage = plan.stages[index];
      for (const input of section.querySelectorAll('input, textarea, select')) stage[input.name] = input.value;
    }
  }

  renderStages();
  document.querySelector('#assignment-add-stage').addEventListener('click', () => {
    if (plan.stages.length >= 100) { status.textContent = 'Достигнут предел в 100 этапов.'; return; }
    syncStagesFromForm();
    const id = `review_stage_${Date.now()}`;
    plan.stages.push({ id, title: '', instruction: '', completion_result: '', material_mode: 'context', material: '' });
    renderStages();
    stagesRoot.lastElementChild?.querySelector('input')?.focus();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    status.textContent = '';
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const sessionResponse = await fetch('/auth/connected/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!sessionResponse.ok) throw new Error('Сессия завершилась. Войдите в профиль заново.');
      const session = await sessionResponse.json();
      if (!session.authenticated || !session.scopes.includes('recruiting.assignment.review'))
        throw new Error('Для сохранения требуется подтверждение доступа к проверке сценария.');
      syncStagesFromForm();
      const stages = plan.stages.map(stage => ({ ...stage }));
      const response = await fetch(`/api/v1/ui/vacancy-assignment?vacancyId=${encodeURIComponent(form.dataset.vacancyId)}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ sourceSha256: form.dataset.sourceSha256,
          plan: { version: 1, stages }, reviewed: form.elements.reviewed.checked })
      });
      const receipt = await response.json();
      if (!response.ok) {
        const messages = { legacy_material_mismatch: 'Сохраните дословный исходный материал хотя бы в одном этапе. Изменённые пояснения добавьте в инструкцию.',
          assignment_source_changed: 'Источник изменился. Обновите страницу и проверьте материал заново.',
          assignment_revision_conflict: 'Для этой вакансии уже сохранена другая проверенная версия.' };
        throw new Error(messages[receipt.error] || 'Не удалось сохранить проверенный сценарий.');
      }
      status.textContent = 'Проверенный сценарий сохранён. Эта версия неизменяема.';
      for (const control of form.querySelectorAll('input, textarea, select, button')) control.disabled = true;
      const heading = document.createElement('p');
      heading.textContent = `SHA-256 версии: ${receipt.revisionSha256}`;
      status.after(heading);
    } catch (error) {
      status.textContent = error.message || 'Не удалось сохранить проверенный сценарий.';
      submit.disabled = false;
    }
  });
}
