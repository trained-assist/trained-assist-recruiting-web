import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const scenarios = JSON.parse(await readFile(new URL('../data/response-evaluation-scenarios.json', import.meta.url), 'utf8'));
const byResponseId = new Map(scenarios.map(item => [item.responseId, item]));

export function getResponseScenario(responseId) { return byResponseId.get(responseId) ?? null; }

export function evaluateSyntheticResponse({ resume, criteria }) {
  const facts = new Map(resume.facts.map(fact => [fact.criterionId, fact.excerpt]));
  const evidence = [];
  const gaps = [];
  for (const criterion of criteria) {
    const excerpt = facts.get(criterion.id);
    if (excerpt) evidence.push({ criterionId: criterion.id, source: 'resume', excerpt });
    else gaps.push({ criterionId: criterion.id, kind: 'missing_evidence', required: criterion.required, reason: 'No synthetic resume fact is mapped to this criterion.' });
  }
  const requiredCriteria = criteria.filter(item => item.required);
  const coveredRequired = requiredCriteria.filter(item => facts.has(item.id)).length;
  const result = coveredRequired === requiredCriteria.length ? 'meets' : coveredRequired === 0 ? 'does_not_meet' : 'partial';
  return { result, evidence, gaps };
}

export function validEvaluatorOutput(output, criteria) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  if (Object.keys(output).sort().join(',') !== 'evidence,gaps,result') return false;
  if (!['meets', 'partial', 'does_not_meet'].includes(output.result) || !Array.isArray(output.evidence) || !Array.isArray(output.gaps)) return false;
  const criterionIds = new Set(criteria.map(item => item.id));
  const seen = new Set();
  for (const [items, kind] of [[output.evidence, 'evidence'], [output.gaps, 'gaps']]) {
    for (const item of items) {
      if (!item || typeof item !== 'object' || !criterionIds.has(item.criterionId) || seen.has(item.criterionId)) return false;
      seen.add(item.criterionId);
      const keys = Object.keys(item).sort().join(',');
      if (kind === 'evidence' && (keys !== 'criterionId,excerpt,source' || item.source !== 'resume' || typeof item.excerpt !== 'string' || !item.excerpt)) return false;
      if (kind === 'gaps' && (keys !== 'criterionId,kind,reason,required' || item.kind !== 'missing_evidence' || typeof item.required !== 'boolean' || typeof item.reason !== 'string' || !item.reason)) return false;
    }
  }
  return seen.size === criteria.length;
}

export function makeEvaluationId(scenario) {
  const key = [scenario.responseId, scenario.responseRevision, scenario.resumeRevision, scenario.criteriaRevision].join('|');
  return `evaluation_demo_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}
