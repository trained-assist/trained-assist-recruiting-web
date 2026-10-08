// Pure mapping of HH /resumes items. No provider call, state write, or LLM assessment.
const GENERIC_WORDS = new Set([
  'опыт', 'опыта', 'опытом', 'работы', 'работа', 'работе', 'знание', 'знания', 'умение',
  'умения', 'навык', 'навыки', 'навыков', 'владение', 'уверенное', 'уверенный', 'понимание',
  'отсутствие', 'наличие', 'также', 'более', 'менее', 'года', 'годы', 'лет', 'желательно',
  'обязательно', 'хорошее', 'хорошие', 'высокий', 'высшее', 'образование', 'внимание',
  'деталям', 'умеет', 'готовность', 'работать', 'других', 'сферы', 'сфере', 'области',
  'with', 'experience', 'knowledge', 'skills', 'years'
]);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const text = value => typeof value === 'string' ? value : '';

function keywords(value) {
  return text(value).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter(word => word.length >= 4 && !GENERIC_WORDS.has(word));
}

function criteriaList(raw, primary, legacy) {
  const source = Array.isArray(raw[primary]) && raw[primary].length ? raw[primary] : raw[legacy] ?? [];
  if (!Array.isArray(source)) throw new TypeError('invalid_ats_criteria');
  return source.map(item => {
    const name = text(item?.name || item?.skill || item?.criterion);
    const weight = Number(item?.weight) || 0;
    if (!Number.isFinite(weight) || weight < 0) throw new TypeError('invalid_ats_weight');
    return { name, weight };
  });
}

export function normalizeHhAtsConfig(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw new TypeError('invalid_ats_config'); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('invalid_ats_config');
  const required = criteriaList(raw, 'required', 'required_skills');
  const preferred = criteriaList(raw, 'preferred', 'preferred_skills');
  const knockout = (raw.knockout ?? []).map(item => text(typeof item === 'string' ? item : item?.criterion || item?.name || item?.skill)).filter(Boolean);
  // Legacy normalization starts with a fallback, then spreads filters over it;
  // an explicit filters.min_experience_years=0 therefore means no threshold.
  const minExperienceYears = Object.prototype.hasOwnProperty.call(raw.filters ?? {}, 'min_experience_years')
    ? Number(raw.filters.min_experience_years) : Number(raw.experience_min_years) || 2;
  if (!Number.isFinite(minExperienceYears) || minExperienceYears < 0) throw new TypeError('invalid_min_experience');
  return { vacancyTitle: text(raw.vacancy_title || raw.title) || 'Вакансия', required, preferred, knockout, minExperienceYears };
}

export function mapHhResumeCandidate(raw, atsConfig, vacancyId, { bypassMinExperience = false } = {}) {
  if (!safeId(vacancyId) || !safeId(raw?.id) || typeof raw.title !== 'string' ||
      (raw.total_experience?.months != null && (!Number.isSafeInteger(raw.total_experience.months) || raw.total_experience.months < 0)) ||
      !Array.isArray(raw.experience ?? [])) throw new TypeError('invalid_hh_resume');
  const config = normalizeHhAtsConfig(atsConfig);
  const months = raw.total_experience?.months ?? 0;
  const minMonths = Math.round(config.minExperienceYears * 12);
  if (months < minMonths && !bypassMinExperience) return { kind: 'excluded', resumeId: raw.id, vacancyId, reason: 'min_experience', minimumMonths: minMonths, actualMonths: months };

  let allText = raw.title.toLowerCase();
  for (const entry of raw.experience) allText += ` ${text(entry?.position).toLowerCase()} ${text(entry?.company).toLowerCase()} ${text(entry?.description).toLowerCase()}`;
  if (raw.certificate !== undefined && !Array.isArray(raw.certificate)) throw new TypeError('invalid_hh_resume');
  allText += ` ${(raw.certificate ?? []).map(item => text(item?.title).toLowerCase()).join(' ')}`;
  const criteria = [...config.required, ...config.preferred];
  let preScore = 1.5;
  const preScoreSignals = [`опыт ${Math.floor(months / 12)}л +1.5`];
  for (const criterion of criteria) {
    const words = keywords(criterion.name);
    if (words.length && words.some(word => allText.includes(word))) {
      preScore += criterion.weight;
      preScoreSignals.push(`${criterion.name} +${criterion.weight}`);
    }
  }
  const totalPossible = 1.5 + criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const preTag = preScore >= totalPossible * 0.55 ? 'PASS' : preScore >= totalPossible * 0.32 ? 'REVIEW' : 'WEAK';
  const experience = raw.experience.slice(0, 5).map(entry => ({ position: text(entry?.position), company: text(entry?.company), start: text(entry?.start), end: entry?.end ?? null }));
  const hhUrl = typeof raw.alternate_url === 'string' && /^https:\/\/(?:www\.)?hh\.ru\/resume\/[a-zA-Z0-9]+(?:[?#].*)?$/.test(raw.alternate_url)
    ? raw.alternate_url : `https://hh.ru/resume/${raw.id}`;
  return { kind: 'candidate', candidate: {
    id: raw.id, vacancyId, hhUrl, title: raw.title, firstName: text(raw.first_name), lastName: text(raw.last_name),
    age: Number.isSafeInteger(raw.age) && raw.age >= 0 ? raw.age : null, area: text(raw.area?.name),
    totalExperienceMonths: months, totalExperienceYears: Math.round(months / 12 * 10) / 10,
    salary: raw.salary ?? null, recentCompanies: raw.experience.slice(0, 3).map(entry => text(entry?.company)).filter(Boolean), experience,
    preScore, preScoreSignals, preTag, totalPossible,
    atsScore: null, atsTag: null, knockout: { status: 'pending_ai', criteria: [...config.knockout] }
  } };
}

export function mapHhResumePage(items, atsConfig, vacancyId) {
  if (!Array.isArray(items) || items.length > 50) throw new TypeError('invalid_hh_page');
  const seen = new Set();
  const candidates = [];
  const excluded = [];
  for (const item of items) {
    const mapped = mapHhResumeCandidate(item, atsConfig, vacancyId);
    if (seen.has(mapped.kind === 'candidate' ? mapped.candidate.id : mapped.resumeId)) continue;
    seen.add(mapped.kind === 'candidate' ? mapped.candidate.id : mapped.resumeId);
    if (mapped.kind === 'candidate') candidates.push(mapped.candidate);
    else excluded.push(mapped);
  }
  candidates.sort((a, b) => b.preScore - a.preScore);
  return { candidates, excluded, totalCollected: seen.size, totalAfterMinExperience: candidates.length };
}
