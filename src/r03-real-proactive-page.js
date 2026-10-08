const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const safeResumeUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru')) &&
      /^\/resume\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

export function renderRealProactivePage({ profileId = '', vacancyId, feed, listView = 'active', historicalAvailable = false,
  responsesAvailable = false, reportsAvailable = false }) {
  if (!['active', 'starred', 'archived'].includes(listView)) throw new TypeError('invalid_list_view');
  const freshness = feed.freshness === 'latest_run_incomplete' ? 'Последний поиск не завершён; показаны ранее принятые кандидаты.' :
    feed.status === 'never_run' && feed.total > 0 ? 'Принятых результатов поиска пока нет; показаны кандидаты, добавленные вручную.' :
    feed.status === 'never_run' ? 'Принятых результатов пока нет.' : 'Показаны принятые результаты поиска.';
  const assessmentPendingCount = feed.assessmentPendingCount ??
    feed.items.filter(item => item.atsScore === null).length;
  const assessmentBlockedCount = feed.assessmentBlockedCount ?? 0;
  const assessmentNotice = assessmentPendingCount > 0
    ? `Ожидают оценки ATS: ${assessmentPendingCount}. Поиск завершён, оценка продолжается отдельно.` : '';
  const assessmentAttention = assessmentBlockedCount > 0
    ? `Оценка ATS требует проверки: ${assessmentBlockedCount}.` : '';
  const counts = { active: 0, starred: 0, archived: 0 };
  for (const item of feed.items) counts[item.review?.status ?? 'active']++;
  const cards = feed.items.filter(item => (item.review?.status ?? 'active') === listView)
    .map(item => `<article data-candidate-id="${escapeHtml(item.id)}" data-job-id="${escapeHtml(item.jobId ?? '')}" data-review-revision="${escapeHtml(item.review?.revision ?? 0)}" data-review-status="${escapeHtml(item.review?.status ?? 'active')}"><h2>${escapeHtml(item.title)}</h2>
    <p>${escapeHtml(item.firstName)} ${escapeHtml(item.lastName)} · ${escapeHtml(item.area)}</p>
    <p>ATS: ${item.atsScore === null ? 'ожидает оценки' : escapeHtml(item.atsScore)} · ${escapeHtml(item.review.status)}</p>
    ${item.jobId ? '<button type="button" class="score-now">Оценить ATS сейчас</button><span class="score-result" role="status"></span>' : ''}
    ${reportsAvailable && item.jobId && item.atsScore !== null && ['active', 'starred'].includes(item.review?.status)
      ? `<p><a href="/auth/connected/start?from=report&amp;vacancy_id=${encodeURIComponent(vacancyId)}&amp;candidate_id=${encodeURIComponent(item.id)}">Подготовить отчёт клиенту</a></p>` : ''}
    ${item.comment ? `<p class="comment">${escapeHtml(item.comment)}</p>` : ''}
    ${safeResumeUrl(item.hhUrl) ? `<a href="${escapeHtml(safeResumeUrl(item.hhUrl))}" target="_blank" rel="noopener noreferrer">Резюме HH</a>` : ''}
    <div class="controls"><label>Статус <select class="candidate-status"><option value="active"${item.review?.status === 'active' ? ' selected' : ''}>Активный</option><option value="starred"${item.review?.status === 'starred' ? ' selected' : ''}>Избранный</option><option value="archived"${item.review?.status === 'archived' ? ' selected' : ''}>Архив</option></select></label>
    <button type="button" class="save-status">Сохранить статус</button><label>Заметка <textarea class="candidate-comment" maxlength="1000">${escapeHtml(item.comment ?? '')}</textarea></label>
    <label><input type="checkbox" class="candidate-exclude"${item.excludeFromSearch ? ' checked' : ''}>Исключить из будущего поиска</label>
    <button type="button" class="save-comment">Сохранить заметку</button></div></article>`).join('');
  const tabs = [['active', 'Активные'], ['starred', 'Избранные'], ['archived', 'Архив']]
    .map(([status, label]) => `<a href="/hh/proactive?vacancy_id=${encodeURIComponent(vacancyId)}&list=${status}"${status === listView ? ' aria-current="page"' : ''}>${label} (${counts[status]})</a>`).join(' ');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Холодный поиск — ${escapeHtml(vacancyId)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#172033;background:#f8fafc}
article{background:white;border:1px solid #d9e2ec;border-radius:10px;padding:1rem;margin:1rem 0}
.notice{padding:1rem;border-radius:8px;background:#fff4ce}.comment{white-space:pre-wrap}
.controls{display:grid;gap:.5rem;margin-top:1rem;max-width:28rem}textarea{display:block;width:100%;min-height:4rem}
nav a{margin-right:1rem}button{cursor:pointer}#action-status{min-height:1.5rem}
</style><script src="/hh/proactive/app.js" defer></script></head><body><main data-profile-id="${escapeHtml(profileId)}" data-vacancy-id="${escapeHtml(vacancyId)}" data-reports-available="${reportsAvailable ? 'true' : 'false'}"><h1>Кандидаты по вакансии ${escapeHtml(vacancyId)}</h1>
<p class="notice">${escapeHtml(freshness)}</p>${assessmentNotice ? `<p class="notice" data-assessment-status="assessment_pending">${escapeHtml(assessmentNotice)}</p>` : ''}${assessmentAttention ? `<p class="notice" data-assessment-status="assessment_attention">${escapeHtml(assessmentAttention)}</p>` : ''}<p id="action-status" role="status" aria-live="polite"></p>
<section><h2>Поиск</h2><p id="schedule-status">Загрузка расписания…</p>
<label>Интервал, часы <input id="interval-hours" type="number" min="0.5" max="8760" step="0.5" value="24"></label>
<button id="schedule-enable" type="button">Включить расписание</button>
<button id="schedule-disable" type="button">Выключить расписание</button>
<p id="vacancy-flags-status">Статус вакансии загружается…</p>
<button id="vacancy-star" type="button">В избранное</button>
<button id="vacancy-unstar" type="button">Убрать из избранного</button>
<button id="vacancy-archive" type="button">Архивировать вакансию</button>
<button id="vacancy-restore" type="button">Восстановить вакансию</button>
<button id="manual-search" type="button">Запустить поиск сейчас</button><p id="manual-status"></p></section>
<section><h2>Запросы поиска</h2><p>Один запрос на строку, максимум 15. Пустой список сбрасывает ручную настройку.</p>
<textarea id="prompt-queries" rows="5" maxlength="8000" aria-label="Запросы поиска"></textarea>
<button id="prompt-save" type="button">Сохранить запросы</button>
<button id="prompt-reset" type="button">Сбросить и создать заново</button>
<p id="prompt-status" role="status" aria-live="polite"></p></section>
<section><h2>Уже просмотренные резюме</h2><p>Вставьте ID или ссылки HH через запятую или с новой строки. Они не будут считаться новыми при следующем поиске.</p>
<textarea id="seen-ids" rows="4" maxlength="16000" aria-label="Уже просмотренные резюме"></textarea>
<button id="seen-import" type="button">Отметить просмотренными</button>
<p id="seen-status" role="status" aria-live="polite"></p></section>
<section><h2>Добавить резюме вручную</h2><p>Укажите ID резюме или ссылку HH. Кандидат будет привязан к этой вакансии.</p>
<input id="manual-candidate-input" type="text" maxlength="512" aria-label="ID или ссылка HH на резюме">
<button id="manual-candidate-add" type="button">Добавить кандидата</button>
<p id="manual-candidate-status" role="status" aria-live="polite"></p></section>
<nav aria-label="Списки кандидатов">${tabs}</nav>${responsesAvailable ? `<p><a href="/hh/responses?vacancy_id=${encodeURIComponent(vacancyId)}">Отклики HH</a></p>` : ''}${historicalAvailable ? `<p><a href="/hh/proactive/history?vacancy_id=${encodeURIComponent(vacancyId)}">Исторические результаты</a></p>` : ''}<p>Всего: ${feed.total}</p>${cards}</main></body></html>`;
}
