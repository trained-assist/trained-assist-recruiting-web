const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

export function renderRealProactivePage({ vacancyId, feed }) {
  const freshness = feed.freshness === 'latest_run_incomplete' ? 'Последний поиск не завершён; показаны ранее принятые кандидаты.' :
    feed.status === 'never_run' ? 'Принятых результатов пока нет.' : 'Показаны принятые результаты поиска.';
  const cards = feed.items.map(item => `<article><h2>${escapeHtml(item.title)}</h2>
    <p>${escapeHtml(item.firstName)} ${escapeHtml(item.lastName)} · ${escapeHtml(item.area)}</p>
    <p>ATS: ${item.atsScore === null ? 'ожидает оценки' : escapeHtml(item.atsScore)} · ${escapeHtml(item.review.status)}</p>
    ${item.comment ? `<p class="comment">${escapeHtml(item.comment)}</p>` : ''}
    <a href="${escapeHtml(item.hhUrl)}" target="_blank" rel="noopener noreferrer">Резюме HH</a></article>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Холодный поиск — ${escapeHtml(vacancyId)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#172033;background:#f8fafc}
article{background:white;border:1px solid #d9e2ec;border-radius:10px;padding:1rem;margin:1rem 0}
.notice{padding:1rem;border-radius:8px;background:#fff4ce}.comment{white-space:pre-wrap}
</style></head><body><main><h1>Кандидаты по вакансии ${escapeHtml(vacancyId)}</h1>
<p class="notice">${escapeHtml(freshness)}</p><p>Всего: ${feed.total}</p>${cards}</main></body></html>`;
}
