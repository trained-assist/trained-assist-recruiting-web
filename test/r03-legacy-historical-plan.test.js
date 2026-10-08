import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classifyLegacyHistoricalSnapshot, planLegacyHistoricalFeed } from '../src/r03-legacy-historical-plan.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const searchedAt = '2026-01-02T07:00:00.000Z';

function fixture(overrides = {}) {
  const payload = { vacancy_id: 'invented_vacancy', searched_at: searchedAt,
    ats_config: { vacancy_id: 'invented_vacancy', required: [] },
    search_queries: ['invented query'], candidates: [{ id: 'invented_resume' }] };
  const rawBytes = Buffer.from(JSON.stringify(payload));
  return { row: { profile_id: 'invented_profile', vacancy_id: 'invented_vacancy',
    source_file: 'search-results-2026-01-02-invented_vacancy.json', searched_at: searchedAt,
    candidate_ids: JSON.stringify(['invented_resume']), payload: JSON.stringify(payload),
    acceptance_status: 'quarantined', unowned_vacancy: 0, unbound_vacancy: 0,
    filename_vacancy_mismatch: 0, unbound_references: 0, vacancy_mismatch_references: 0 },
  rawBytes, sourceReceipt: { bytes: rawBytes.length, sha256: sha(rawBytes) },
  isVacancyOwned: (profile, vacancy) => profile === 'invented_profile' && vacancy === 'invented_vacancy',
  candidates: new Map([['invented_resume', ['invented_vacancy']]]),
  seen: new Map([['invented_resume', '2026-01-01T00:00:00.000Z']]),
  currentPlan: { profileId: 'invented_profile', vacancyId: 'invented_vacancy',
    atsConfig: payload.ats_config, queryCache: { pendingGeneration: false } }, ...overrides };
}

test('verified old bytes remain historical only and never become accepted', () => {
  const row = classifyLegacyHistoricalSnapshot(fixture());
  assert.equal(row.historicalReadable, true);
  assert.equal(row.currentCriteriaMatch, true);
  assert.equal(row.accepted, false);
  assert.deepEqual(row.acceptanceBlockers, ['missing_occurrence_bound_receipt',
    'missing_criteria_revision', 'missing_source_revision']);
  assert.match(row.historicalCriteriaFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(planLegacyHistoricalFeed([row]).accepted, 0);
});

test('ownership, filename, raw byte, list, membership and seen anomalies each quarantine', () => {
  const variants = [
    [fixture({ isVacancyOwned: () => false }), 'scope_unowned'],
    [fixture({ row: { ...fixture().row, source_file: 'search-results-other.json' } }), 'source_filename_mismatch'],
    [fixture({ rawBytes: Buffer.from('{}') }), 'byte_receipt_mismatch'],
    [fixture({ row: { ...fixture().row, candidate_ids: '[]' } }), 'candidate_list_mismatch'],
    [fixture({ candidates: new Map([['invented_resume', []]]) }), 'candidate_membership_missing'],
    [fixture({ seen: new Map() }), 'seen_missing'],
    [fixture({ seen: new Map([['invented_resume', '2026-01-03T00:00:00.000Z']]) }), 'seen_after_search'],
    [fixture({ row: { ...fixture().row, vacancy_mismatch_references: 1 } }), 'imported_candidate_anomaly']
  ];
  for (const [input, reason] of variants) {
    const result = classifyLegacyHistoricalSnapshot(input);
    assert.equal(result.historicalReadable, false, reason);
    assert.ok(result.reasons.includes(reason), reason);
    assert.equal(result.accepted, false);
  }
});

test('a 96-row synthetic plan counts all classes and recommends only latest ready matching scope', () => {
  const rows = Array.from({ length: 96 }, (_, index) => {
    const input = fixture();
    input.row.source_file = `search-results-${String(index).padStart(3, '0')}-invented_vacancy.json`;
    input.row.searched_at = new Date(Date.parse(searchedAt) + index * 1000).toISOString();
    input.rawBytes = Buffer.from(JSON.stringify({ ...JSON.parse(input.row.payload),
      searched_at: input.row.searched_at }));
    input.row.payload = input.rawBytes.toString();
    input.sourceReceipt = { bytes: input.rawBytes.length, sha256: sha(input.rawBytes) };
    if (index < 13) input.row.filename_vacancy_mismatch = 1;
    if (index === 20) input.currentPlan = null;
    if (index === 21) input.currentPlan = { ...input.currentPlan,
      atsConfig: { vacancy_id: 'invented_vacancy', required: ['different'] } };
    return classifyLegacyHistoricalSnapshot(input);
  });
  const plan = planLegacyHistoricalFeed(rows);
  assert.equal(plan.total, 96);
  assert.equal(plan.historicalReadable, 83);
  assert.equal(plan.blocked, 13);
  assert.equal(plan.reasons.source_filename_mismatch, 13);
  assert.equal(plan.recommendedLatest.length, 1);
  assert.equal(plan.accepted, 0);
  assert.ok(rows.every(row => !row.accepted));
});
