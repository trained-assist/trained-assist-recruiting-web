// Browser client for the private real-HH page. The signed legacy URL is only
// used to establish the server-side profile session; requests carry no token.
const root = document.querySelector('main[data-vacancy-id]');
if (root) {
  const profileId = root.dataset.profileId;
  const vacancyId = root.dataset.vacancyId;
  const status = document.getElementById('action-status');
  const manualStatus = document.getElementById('manual-status');
  const scheduleStatus = document.getElementById('schedule-status');
  const list = new URL(location.href).searchParams.get('list');
  history.replaceState(null, '', `/hh/proactive?vacancy_id=${encodeURIComponent(vacancyId)}${list ? `&list=${encodeURIComponent(list)}` : ''}`);

  const request = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };
  const command = (path, body, headers = {}) => request(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
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
    promptStatus.textContent = result.queries_manual ? 'Запросы сохранены вручную.' : 'Показаны запросы, созданные из вакансии.';
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
