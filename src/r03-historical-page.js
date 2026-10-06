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

export function renderR03HistoricalPage({ vacancyId, result }) {
  if (result?.status !== 'historical_only' || result.vacancyId !== vacancyId ||
      !Array.isArray(result.candidates)) throw new TypeError('historical_page_evidence_required');
  const cards = result.candidates.map(item => `<article><h2>${escapeHtml(item.title || 'Кандидат')}</h2>
<p>${escapeHtml([item.lastName, item.firstName].filter(Boolean).join(' '))}</p>
<p>${escapeHtml(item.area)}${item.score === null ? '' : ` · Оценка: ${escapeHtml(item.score)}`}</p>
${safeResumeUrl(item.hhUrl) ? `<a href="${escapeHtml(safeResumeUrl(item.hhUrl))}" target="_blank" rel="noopener noreferrer">Резюме HH</a>` : ''}</article>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>История поиска — ${escapeHtml(vacancyId)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#172033;background:#f8fafc}article{background:white;border:1px solid #d9e2ec;border-radius:10px;padding:1rem;margin:1rem 0}.notice{padding:1rem;border-radius:8px;background:#fff4ce}</style></head>
<body><main><h1>Исторические результаты по вакансии ${escapeHtml(vacancyId)}</h1>
<p class="notice">Снимок от ${escapeHtml(result.searchedAt)}. Это архивные данные; они не подтверждают свежесть поиска.</p>
<p><a href="/hh/proactive?vacancy_id=${encodeURIComponent(vacancyId)}">Текущие результаты</a></p>
<p>В снимке: ${result.total}</p>${cards}</main></body></html>`;
}
