const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

export function renderPrivateVacancyPicker(vacancyIds) {
  if (!Array.isArray(vacancyIds) || vacancyIds.length < 1 || vacancyIds.length > 1000 ||
      vacancyIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
      new Set(vacancyIds).size !== vacancyIds.length) throw new TypeError('private_vacancy_picker_invalid');
  const links = vacancyIds.map(id => `<li><a href="/hh/proactive?vacancy_id=${encodeURIComponent(id)}">${escapeHtml(id)}</a></li>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Выберите вакансию — холодный поиск</title></head><body><main><h1>Выберите вакансию</h1><p><a href="/hh/responses">Отклики HH</a></p><ul>${links}</ul></main></body></html>`;
}
