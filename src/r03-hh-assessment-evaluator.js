import { normalizeHhAtsConfig } from './hh-resume-mapping.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = () => { throw new Error('hh_assessment_unavailable'); };
const boundedText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

// LLM judgment stays behind a deterministic, revision-bound DTO. This adapter
// intentionally never sends candidate name, contact data, token or HH URL.
export function createHhAssessmentEvaluator({ loadSearchPlan, chat } = {}) {
  if (typeof loadSearchPlan !== 'function' || typeof chat !== 'function')
    throw new TypeError('ATS plan and free ladder ports required');
  return async ({ profileId, vacancyId, candidate, criteriaRevision, inputRevision } = {}) => {
    if (!safeId(profileId) || !safeId(vacancyId) || !safeId(candidate?.id) ||
        candidate.vacancyId !== vacancyId || typeof criteriaRevision !== 'string' || !criteriaRevision ||
        typeof inputRevision !== 'string' || !/^[a-f0-9]{32}$/.test(inputRevision)) fail();
    let plan, config;
    try {
      plan = await loadSearchPlan(profileId, vacancyId);
      if (plan?.profileId !== profileId || plan?.vacancyId !== vacancyId ||
          plan.criteriaRevision !== criteriaRevision) fail();
      config = normalizeHhAtsConfig(plan.atsConfig);
    } catch { fail(); }
    const experience = Array.isArray(candidate.experience) ? candidate.experience.slice(0, 5)
      .map(row => `${boundedText(row.position, 200)} — ${boundedText(row.company, 200)}`).join('; ') : '';
    const knockout = config.knockout.slice(0, 20);
    const prompt = `Оцени кандидата для вакансии «${boundedText(config.vacancyTitle, 500)}».\n` +
      `Контекст: ${boundedText(plan.atsConfig.vacancy_context, 6000)}\n` +
      `Обязательные: ${config.required.map(item => `${item.name} (${item.weight})`).join('; ').slice(0, 6000)}\n` +
      `Желательные: ${config.preferred.map(item => `${item.name} (${item.weight})`).join('; ').slice(0, 6000)}\n` +
      `Стоп-факторы: ${knockout.join('; ').slice(0, 4000)}\n` +
      `Должность: ${boundedText(candidate.title, 300)}; опыт: ${candidate.totalExperienceYears}; ` +
      `компании: ${Array.isArray(candidate.recentCompanies) ? candidate.recentCompanies.slice(0, 3).map(item => boundedText(item, 200)).join(', ') : ''}; ` +
      `карьера: ${experience}.\n` +
      'Ответь JSON-объектом {"score": 0-10, "knockout_failed": []}. В knockout_failed перечисляй только явно нарушенные стоп-факторы дословно из списка. Если данных недостаточно, не считай стоп-фактор нарушенным. Оцени по подтверждённому опыту; не додумывай факты.';
    let response;
    try { response = await chat({ messages: [{ role: 'user', content: prompt }],
      ladder: 'free', temperature: 0.1, maxTokens: 600, timeoutMs: 25_000,
      source: 'hh-enrich' }); } catch { fail(); }
    if (typeof response !== 'string') fail();
    const match = response.match(/\{[\s\S]*\}/);
    let value;
    try { value = JSON.parse(match?.[0] ?? ''); } catch { fail(); }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.score !== 'number' || !Number.isFinite(value.score) ||
        !Array.isArray(value.knockout_failed) || value.knockout_failed.length > 20 ||
        value.knockout_failed.some(item => typeof item !== 'string' || !knockout.includes(item))) fail();
    const failed = [...new Set(value.knockout_failed)];
    const score = Math.round(Math.max(0, Math.min(failed.length ? 2 : 10, value.score)) * 2) / 2;
    const strong = Number(plan.atsConfig.pass_threshold ?? plan.atsConfig.thresholds?.strong ?? 7);
    const review = Number(plan.atsConfig.review_threshold ?? plan.atsConfig.thresholds?.consider ?? 5);
    if (![strong, review].every(Number.isFinite) || review < 0 || strong > 10 || review > strong) fail();
    return { atsScore: score, atsTag: score >= strong ? 'PASS' : score >= review ? 'REVIEW' : 'WEAK',
      knockout: { status: failed.length ? 'failed' : 'passed', criteria: failed } };
  };
}
