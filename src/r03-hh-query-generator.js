import { normalizeHhAtsConfig } from './hh-resume-mapping.js';

const generic = new Set(['опыт', 'опыта', 'работы', 'работа', 'знание', 'знания',
  'умение', 'навыки', 'навыков', 'области', 'сфере', 'специалист', 'with', 'experience']);
const words = value => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/).filter(word => word.length >= 4 && !generic.has(word));
const valid = queries => Array.isArray(queries) && queries.length >= 1 && queries.length <= 15 &&
  queries.every(query => typeof query === 'string' && query.length <= 500 && query.trim() === query && query.length > 0) &&
  new Set(queries).size === queries.length;
const fail = () => { throw new Error('hh_query_generation_unavailable'); };

function fallback(config) {
  const title = config.vacancyTitle.trim();
  const criteria = [...config.required, ...config.preferred]
    .filter(item => item.name.trim()).sort((a, b) => b.weight - a.weight).slice(0, 3)
    .map(item => item.name.trim().split(/\s+/).slice(0, 3).join(' '));
  return [...new Set([title, ...criteria].filter(Boolean))].slice(0, 6);
}

function looksSane(queries, raw, config) {
  const anchors = new Set([config.vacancyTitle, raw.vacancy_context,
    ...config.required.map(item => item.name), ...config.preferred.map(item => item.name)].flatMap(words));
  if (!anchors.size) return false;
  const matched = queries.filter(query => words(query).some(word => anchors.has(word))).length;
  return matched >= Math.max(1, Math.ceil(queries.length * 0.4));
}

// chat is a host-owned LLM ladder port. Its response can be malformed or off
// topic; only bounded, domain-relevant queries may reach the HH transport.
export function createHhQueryGenerator({ chat }) {
  if (typeof chat !== 'function') throw new TypeError('HH query chat port required');
  return async ({ profileId, vacancyId, atsConfig, comments = [] }) => {
    if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(profileId) ||
        typeof vacancyId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(vacancyId) ||
        !Array.isArray(comments) || comments.length > 200 ||
        comments.some(comment => typeof comment !== 'string' || comment.length > 2000)) fail();
    let config;
    try { config = normalizeHhAtsConfig(atsConfig); } catch { fail(); }
    if (config.vacancyTitle === 'Вакансия' && ![...config.required, ...config.preferred].some(item => item.name.trim())) fail();
    const backup = fallback(config);
    if (!valid(backup)) fail();
    const prompt = `Вакансия: ${config.vacancyTitle}\nКонтекст: ${String(atsConfig.vacancy_context ?? '').slice(0, 8000)}\n` +
      `Критерии: ${[...config.required, ...config.preferred].map(item => item.name).join('; ').slice(0, 8000)}\n` +
      `Стоп-факторы: ${config.knockout.join('; ').slice(0, 4000)}\n` +
      `Комментарии рекрутера: ${comments.join('; ').slice(0, 8000)}\n` +
      'Верни JSON-массив из 5–7 специализированных запросов для поиска резюме HH. Каждый запрос — 2–4 слова. Без markdown.';
    let answer;
    try { answer = await chat({ messages: [{ role: 'user', content: prompt }],
      ladder: 'service', temperature: 0.3, maxTokens: 300, timeoutMs: 20_000,
      source: 'hh-proactive' }); }
    catch { fail(); }
    let generated = null;
    if (typeof answer === 'string') {
      const match = answer.match(/\[[\s\S]*\]/);
      if (match) {
        try { generated = JSON.parse(match[0]); } catch {}
      }
    }
    if (!valid(generated) || !looksSane(generated, atsConfig, config)) return backup;
    return generated;
  };
}
