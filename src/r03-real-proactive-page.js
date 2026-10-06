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

export function renderRealProactivePage({ vacancyId, feed, listView = 'active' }) {
  if (!['active', 'starred', 'archived'].includes(listView)) throw new TypeError('invalid_list_view');
  const freshness = feed.freshness === 'latest_run_incomplete' ? 'Последний поиск не завершён; показаны ранее принятые кандидаты.' :
    feed.status === 'never_run' ? 'Принятых результатов пока нет.' : 'Показаны принятые результаты поиска.';
  const counts = { active: 0, starred: 0, archived: 0 };
  for (const item of feed.items) counts[item.review?.status ?? 'active']++;
  const cards = feed.items.filter(item => (item.review?.status ?? 'active') === listView)
    .map(item => `<article data-candidate-id="${escapeHtml(item.id)}" data-review-revision="${escapeHtml(item.review?.revision ?? 0)}"><h2>${escapeHtml(item.title)}</h2>
    <p>${escapeHtml(item.firstName)} ${escapeHtml(item.lastName)} · ${escapeHtml(item.area)}</p>
    <p>ATS: ${item.atsScore === null ? 'ожидает оценки' : escapeHtml(item.atsScore)} · ${escapeHtml(item.review.status)}</p>
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
</style><script src="/hh/proactive/app.js" defer></script></head><body><main data-vacancy-id="${escapeHtml(vacancyId)}"><h1>Кандидаты по вакансии ${escapeHtml(vacancyId)}</h1>
<p class="notice">${escapeHtml(freshness)}</p><p id="action-status" role="status" aria-live="polite"></p>
<section><h2>Поиск</h2><p id="schedule-status">Загрузка расписания…</p>
<label>Интервал, часы <input id="interval-hours" type="number" min="0.5" max="8760" step="0.5" value="24"></label>
<button id="schedule-enable" type="button">Включить расписание</button>
<button id="schedule-disable" type="button">Выключить расписание</button>
<button id="manual-search" type="button">Запустить поиск сейчас</button><p id="manual-status"></p></section>
<nav aria-label="Списки кандидатов">${tabs}</nav><p>Всего: ${feed.total}</p>${cards}</main></body></html>`;
}
