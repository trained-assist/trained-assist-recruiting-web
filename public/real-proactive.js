// Browser client for the private real-HH page. Authentication is a server-side
// session; requests never carry an app token or legacy link secret in JSON.
const root = document.querySelector('main[data-vacancy-id]');
if (root) {
  const profileId = root.dataset.profileId;
  const vacancyId = root.dataset.vacancyId;
  const status = document.getElementById('action-status');
  const manualStatus = document.getElementById('manual-status');
  const scheduleStatus = document.getElementById('schedule-status');
  const flagsStatus = document.getElementById('vacancy-flags-status');
  let currentFlags = null;
  const list = new URL(location.href).searchParams.get('list');
  history.replaceState(null, '', `/hh/proactive?vacancy_id=${encodeURIComponent(vacancyId)}${list ? `&list=${encodeURIComponent(list)}` : ''}`);

  const request = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };
  let commandCsrf;
  const csrfHeader = async () => {
    if (commandCsrf !== undefined) return commandCsrf ? { 'X-CSRF-Token': commandCsrf } : {};
    const response = await fetch('/auth/connected/session', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 404) { commandCsrf = null; return {}; } // Legacy signed-link mode.
    const session = await response.json().catch(() => ({}));
    if (!response.ok || !/^[A-Za-z0-9_-]{43}$/.test(session.csrfToken ?? ''))
      throw new Error(session.error || 'browser_session_unavailable');
    commandCsrf = session.csrfToken;
    return { 'X-CSRF-Token': commandCsrf };
  };
  const command = async (path, body, headers = {}) => request(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...await csrfHeader(), ...headers }, body: JSON.stringify(body) });
  const message = error => error instanceof Error ? error.message : 'action_unavailable';
  let manualBlocked = false;
  const run = async (button, action) => {
    button.disabled = true;
    status.textContent = '';
    try { await action(); } catch (error) { status.textContent = `Действие не выполнено: ${message(error)}`; }
    finally { button.disabled = button.id === 'manual-search' && manualBlocked; }
  };
  const refreshSchedule = async () => {
    const result = await request(`/api/hh/proactive/schedule?vacancy_id=${encodeURIComponent(vacancyId)}`);
    const schedule = result.schedules[0];
    currentFlags = result.flags;
    flagsStatus.textContent = currentFlags ?
      `Вакансия: ${currentFlags.archived ? 'в архиве' : 'активна'}${currentFlags.starred ? ', в избранном' : ''}.` :
      'Статус вакансии недоступен.';
    scheduleStatus.textContent = !schedule ? 'Расписание не создано.' :
      schedule.blockedByUnknownOccurrenceId ? 'Расписание заблокировано: исход прошлого запуска неизвестен.' :
      schedule.enabled ? `Включено. Следующий запуск: ${schedule.nextRunAt || 'уточняется'}.` : 'Выключено.';
  };
  refreshSchedule().catch(error => { scheduleStatus.textContent = `Расписание недоступно: ${message(error)}`; });
  const promptStatus = document.getElementById('prompt-status');
  const promptInput = document.getElementById('prompt-queries');
  let promptState = null;
  const refreshPrompt = async () => {
    const result = await request(`/api/hh/proactive/prompt?vacancy_id=${encodeURIComponent(vacancyId)}`);
    promptState = result;
    promptInput.value = result.queries.join('\n');
    promptStatus.textContent = result.pending_regeneration ? 'Запросы ещё не созданы. Можно задать их вручную или выполнить сброс с генерацией.' :
      result.queries_manual ? 'Запросы сохранены вручную.' : 'Показаны запросы, созданные из вакансии.';
  };
  refreshPrompt().catch(error => { promptStatus.textContent = `Запросы недоступны: ${message(error)}`; });
  const savePrompt = async (queries, reset = false) => {
    if (!promptState) throw new Error('Сначала загрузите текущие запросы.');
    let result;
    try { result = await command('/api/hh/proactive/prompt', { vacancy_id: vacancyId, queries,
      expected_revision: promptState.query_revision,
      expected_override_revision: promptState.override_revision }); }
    catch (error) {
      if (message(error) === 'query_revision_conflict') {
        await refreshPrompt();
        throw new Error('Запросы изменились. Проверьте обновлённый список и сохраните снова.');
      }
      throw error;
    }
    if (result.pending_regeneration) {
      promptStatus.textContent = 'Настройка сброшена; запросы создаются заново.';
      try { await refreshPrompt(); } catch { /* persisted reset remains visible */ }
    } else {
      promptState = result;
      promptInput.value = result.queries.join('\n');
      promptStatus.textContent = reset ? 'Настройка сброшена.' : 'Запросы сохранены.';
    }
  };
  document.getElementById('prompt-save').addEventListener('click', event => run(event.currentTarget,
    () => savePrompt(promptInput.value)));
  document.getElementById('prompt-reset').addEventListener('click', event => run(event.currentTarget,
    () => savePrompt('', true)));
  const seenInput = document.getElementById('seen-ids');
  const seenStatus = document.getElementById('seen-status');
  const resumeId = value => {
    if (/^[A-Za-z0-9]{1,128}$/.test(value)) return value;
    let url;
    try { url = new URL(value); } catch { throw new Error('Укажите ID или ссылку HH на резюме.'); }
    const match = /^\/resume\/([A-Za-z0-9]{1,128})\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || !['hh.ru', 'www.hh.ru'].includes(url.hostname) ||
        url.username || url.password || !match) throw new Error('Некорректная ссылка HH на резюме.');
    return match[1];
  };
  document.getElementById('seen-import').addEventListener('click', event => run(event.currentTarget, async () => {
    const parts = seenInput.value.split(/[\n\r,]+/).map(value => value.trim()).filter(Boolean);
    if (!parts.length || parts.length > 500) throw new Error('Укажите от 1 до 500 ID резюме.');
    const ids = [...new Set(parts.map(resumeId))];
    const result = await command('/api/hh/proactive/import-seen', { vacancy_id: vacancyId, ids });
    seenStatus.textContent = `Добавлено ${result.imported}; всего просмотренных по вакансии ${result.total}.`;
    seenInput.value = '';
  }));
  const manualCandidateInput = document.getElementById('manual-candidate-input');
  const manualCandidateStatus = document.getElementById('manual-candidate-status');
  document.getElementById('manual-candidate-add')?.addEventListener('click', event => run(event.currentTarget, async () => {
    const value = manualCandidateInput.value.trim();
    const id = resumeId(value);
    const result = await command('/api/hh/proactive/add-manual', { vacancy_id: vacancyId,
      resume_url_or_id: id });
    manualCandidateStatus.textContent = result.added ? 'Кандидат добавлен. Обновите страницу.' :
      'Этот кандидат уже добавлен в вакансию.';
    manualCandidateInput.value = '';
  }));
  document.getElementById('schedule-enable').addEventListener('click', event => run(event.currentTarget, async () => {
    const interval = Number(document.getElementById('interval-hours').value);
    if (!Number.isFinite(interval) || interval < 0.5 || interval > 8760) throw new Error('Укажите интервал от 0,5 до 8760 часов.');
    await command('/api/hh/proactive/vacancy-state', { vacancy_id: vacancyId, action: 'enable', interval_hours: interval });
    await refreshSchedule();
    status.textContent = 'Расписание включено.';
  }));
  document.getElementById('schedule-disable').addEventListener('click', event => run(event.currentTarget, async () => {
    await command('/api/hh/proactive/vacancy-state', { vacancy_id: vacancyId, action: 'disable' });
    await refreshSchedule();
    status.textContent = 'Расписание выключено.';
  }));
  for (const action of ['star', 'unstar', 'archive', 'restore']) {
    document.getElementById(`vacancy-${action}`).addEventListener('click', event => run(event.currentTarget, async () => {
      if (!currentFlags) throw new Error('Сначала загрузите статус вакансии.');
      try {
        await command('/api/hh/proactive/vacancy-state', { vacancy_id: vacancyId, action,
          expected_revision: currentFlags.revision });
      } catch (error) {
        if (message(error) === 'vacancy_flag_revision_conflict') {
          await refreshSchedule();
          throw new Error('Статус вакансии изменился. Проверьте обновлённое состояние.');
        }
        throw error;
      }
      await refreshSchedule();
      status.textContent = action === 'archive' ? 'Вакансия архивирована, расписание выключено.' :
        action === 'restore' ? 'Вакансия восстановлена. Расписание можно включить отдельно.' :
        action === 'star' ? 'Вакансия в избранном.' : 'Вакансия убрана из избранного.';
    }));
  }

  const runStorageKey = `r03:manual-run:${profileId}:${vacancyId}`;
  const requestStorageKey = `r03:manual-request:${profileId}:${vacancyId}`;
  const stored = key => { try { return sessionStorage.getItem(key); } catch { return null; } };
  const remember = (key, value) => { try { sessionStorage.setItem(key, value); } catch { /* unavailable */ } };
  const forget = key => { try { sessionStorage.removeItem(key); } catch { /* unavailable */ } };
  let pendingManualKey = stored(requestStorageKey);
  const pollManual = async runId => {
    manualStatus.textContent = 'Поиск выполняется. Ожидаем результат…';
    for (let attempt = 0; attempt < 120; attempt++) {
      const polled = await request(`/api/hh/proactive/manual-runs/${encodeURIComponent(runId)}`);
      const state = polled.run.status;
      if (state === 'completed') { forget(runStorageKey); location.reload(); return; }
      if (state === 'outcome_unknown') {
        manualStatus.textContent = 'Исход поиска неизвестен. Повторный запуск требует разбирательства.';
        manualBlocked = true;
        document.getElementById('manual-search').disabled = true;
        return;
      }
      if (state !== 'running') {
        forget(runStorageKey);
        manualStatus.textContent = `Поиск завершён со статусом ${state}.`;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    manualStatus.textContent = 'Поиск ещё выполняется. Обновите страницу позже.';
  };
  const rememberedRun = stored(runStorageKey);
  if (rememberedRun) pollManual(rememberedRun).catch(error => {
    if (message(error) === 'run_not_found') forget(runStorageKey);
    manualStatus.textContent = `Статус поиска недоступен: ${message(error)}`;
  });
  document.getElementById('manual-search').addEventListener('click', event => run(event.currentTarget, async () => {
    if (stored(runStorageKey)) throw new Error('Предыдущий поиск ещё отслеживается.');
    if (!pendingManualKey) { pendingManualKey = crypto.randomUUID(); remember(requestStorageKey, pendingManualKey); }
    const result = await command('/api/hh/proactive/search', { vacancy_id: vacancyId },
      { 'Idempotency-Key': pendingManualKey });
    pendingManualKey = null;
    forget(requestStorageKey);
    remember(runStorageKey, result.run.runId);
    await pollManual(result.run.runId);
  }));

  for (const card of document.querySelectorAll('article[data-candidate-id]')) {
    const candidateId = card.dataset.candidateId;
    const expectedRevision = () => Number(card.dataset.reviewRevision);
    const scoreButton = card.querySelector('.score-now');
    if (scoreButton) scoreButton.addEventListener('click', event => run(event.currentTarget, async () => {
      const result = await command('/api/hh/proactive/ai-score', { vacancy_id: vacancyId,
        candidate_id: candidateId, expected_job_id: card.dataset.jobId });
      card.querySelector('.score-result').textContent = ` ATS: ${result.atsScore} (${result.atsTag}).`;
    }));
    card.querySelector('.save-status').addEventListener('click', event => run(event.currentTarget, async () => {
      await command('/api/hh/proactive/set-status', { vacancy_id: vacancyId, candidate_id: candidateId,
        expected_revision: expectedRevision(), status: card.querySelector('.candidate-status').value });
      location.reload();
    }));
    card.querySelector('.save-comment').addEventListener('click', event => run(event.currentTarget, async () => {
      await command('/api/hh/proactive/comment', { vacancy_id: vacancyId, candidate_id: candidateId,
        expected_revision: expectedRevision(), comment: card.querySelector('.candidate-comment').value,
        exclude_from_search: card.querySelector('.candidate-exclude').checked });
      location.reload();
    }));
  }
}
