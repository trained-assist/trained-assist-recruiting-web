import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportSources = JSON.parse(await readFile(join(root, 'data/report-scenarios.json'), 'utf8'));
const vacancyRecords = JSON.parse(await readFile(join(root, 'data/vacancies.json'), 'utf8'));
const reportByCandidateId = new Map(reportSources.map(source => [source.candidateId, source]));
const vacancyById = new Map(vacancyRecords.map(vacancy => [vacancy.id, vacancy]));

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function projectClientView(source, vacancy) {
  // Allowlist projection: internal source fields are never copied to the client DTO.
  return {
    candidateName: source.candidate.name,
    position: source.candidate.position,
    vacancyTitle: vacancy.title,
    summary: source.client.summary,
    experience: source.client.experience.map(item => ({
      company: item.company,
      role: item.role,
      period: item.period,
      details: [...item.details]
    })),
    fit: source.client.fit.map(item => ({
      requirement: item.requirement,
      status: item.status,
      comment: item.comment
    })),
    conclusion: source.client.conclusion
  };
}

function renderClientReport(view, sourceRevision) {
  const candidateName = escapeHtml(view.candidateName);
  const position = escapeHtml(view.position);
  const vacancyTitle = escapeHtml(view.vacancyTitle);
  const experience = view.experience.map(item => `
    <article><h3>${escapeHtml(item.role)} — ${escapeHtml(item.company)}</h3>
      <p>${escapeHtml(item.period)}</p>
      <ul>${item.details.map(detail => `<li>${escapeHtml(detail)}</li>`).join('')}</ul>
    </article>`).join('');
  const fit = view.fit.map(item => `<tr>
    <td>${escapeHtml({ yes: 'Соответствует', partial: 'Частично', no: 'Не соответствует' }[item.status])}</td>
    <td>${escapeHtml(item.requirement)}</td>
    <td>${escapeHtml(item.comment)}</td>
  </tr>`).join('');

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="report-source-revision" content="${escapeHtml(sourceRevision)}">
<title>${candidateName} — ${vacancyTitle}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;color:#17212b;max-width:48rem;margin:2rem auto;padding:0 1rem}h1,h2{color:#174b64}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ccd5db;padding:.5rem;text-align:left;vertical-align:top}</style></head>
<body><main><aside><strong>СИНТЕТИЧЕСКИЙ ЧЕРНОВИК · НЕ ДЛЯ ОТПРАВКИ</strong></aside><h1>${candidateName}</h1><p>${position} · ${vacancyTitle}</p>
<section><h2>О кандидате</h2><p>${escapeHtml(view.summary)}</p></section>
<section><h2>Опыт</h2>${experience}</section>
<section><h2>Соответствие вакансии</h2><table><thead><tr><th>Оценка</th><th>Требование</th><th>Комментарий</th></tr></thead><tbody>${fit}</tbody></table></section>
<section><h2>Заключение рекрутера</h2><p>${escapeHtml(view.conclusion)}</p></section>
</main></body></html>`;
}

export function createClientReportPreview(candidateId, vacancyId) {
  const source = reportByCandidateId.get(candidateId);
  if (!source) return { kind: 'candidate_not_found' };
  if (source.vacancyId !== vacancyId) return { kind: 'candidate_vacancy_mismatch' };
  const vacancy = vacancyById.get(vacancyId);
  if (!vacancy) return { kind: 'vacancy_not_found' };
  const clientView = projectClientView(source, vacancy);

  return {
    kind: 'preview',
    body: {
      domainApiVersion: 'v1',
      mode: 'preview',
      audience: 'client',
      previewOnly: true,
      publication: 'disabled',
      candidateId: source.candidateId,
      vacancyId: source.vacancyId,
      sourceRevision: source.sourceRevision,
      clientView,
      html: renderClientReport(clientView, source.sourceRevision)
    }
  };
}
