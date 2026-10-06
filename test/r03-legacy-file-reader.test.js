import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLegacyR03ProfileFiles } from '../src/r03-legacy-file-reader.js';

function inventedTree(t) {
  const root = mkdtempSync(join(tmpdir(), 'r03-legacy-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const proactiveDirectory = join(root, 'proactive');
  const contextDirectory = join(root, 'contexts');
  mkdirSync(proactiveDirectory); mkdirSync(contextDirectory);
  const write = (directory, name, value) => writeFileSync(join(directory, name), JSON.stringify(value));
  write(proactiveDirectory, 'all-candidates.json', {
    inventedresume01: { id: 'inventedresume01', first_name: 'SECRET_SYNTHETIC_NAME', vacancy_ids: ['vacancy01'] },
  });
  write(proactiveDirectory, 'seen-ids.json', { vacancy01: { inventedresume01: '2026-09-28' } });
  write(proactiveDirectory, 'search-results-2026-09-28-vacancy01.json', {
    vacancy_id: 'vacancy01', searched_at: '2026-09-28T08:00:00.000Z',
    candidates: [{ id: 'inventedresume01', first_name: 'SECRET_SYNTHETIC_NAME' }],
  });
  write(proactiveDirectory, 'queries-vacancy01.json', {
    vacancy_id: 'vacancy01', queries: ['SECRET_SYNTHETIC_QUERY'], manual: true,
  });
  write(proactiveDirectory, 'candidate-comments-vacancy01.json', {
    inventedresume01: { text: 'SECRET_SYNTHETIC_COMMENT' },
  });
  write(contextDirectory, 'ats_config:vacancy01.json', { value: { vacancy_title: 'SECRET_SYNTHETIC_ATS' } });
  return { root, proactiveDirectory, contextDirectory, sourceProfileRef: 'invented_source',
    hmacKey: Buffer.alloc(32, 5), schedules: [] };
}

test('read-only source adapter fingerprints all six inventoried files and drops free text', t => {
  const input = inventedTree(t);
  const first = readLegacyR03ProfileFiles(input);
  assert.equal(first.fileReceipts.length, 6);
  assert.equal(first.profile.snapshots.length, 1);
  assert.equal(first.profile.queryCaches[0].manual, true);
  assert.equal(first.fileReceipts.every(receipt => /^[a-f0-9]{64}$/.test(receipt.hmac)), true);
  assert.deepEqual(readLegacyR03ProfileFiles(input), first);
  const serialized = JSON.stringify(first);
  for (const forbidden of ['SECRET_SYNTHETIC_NAME', 'SECRET_SYNTHETIC_QUERY',
    'SECRET_SYNTHETIC_COMMENT', 'SECRET_SYNTHETIC_ATS']) assert.equal(serialized.includes(forbidden), false);
});

test('unscoped source, missing core file and symlinked source fail closed', t => {
  const input = inventedTree(t);
  writeFileSync(join(input.proactiveDirectory, 'candidate-comments.json'), '{}');
  assert.throws(() => readLegacyR03ProfileFiles(input), /unscoped_legacy_source_requires_mapping/);
  rmSync(join(input.proactiveDirectory, 'candidate-comments.json'));
  rmSync(join(input.proactiveDirectory, 'all-candidates.json'));
  assert.throws(() => readLegacyR03ProfileFiles(input), /missing_legacy_source_core_file/);
  symlinkSync(join(input.root, 'outside.json'), join(input.proactiveDirectory, 'all-candidates.json'));
  assert.throws(() => readLegacyR03ProfileFiles(input), /legacy_source_file_unavailable/);
});

test('old unscoped snapshot filename is not silently omitted', t => {
  const input = inventedTree(t);
  writeFileSync(join(input.proactiveDirectory, 'search-results-2026-09-28.json'), '{}');
  assert.throws(() => readLegacyR03ProfileFiles(input), /unmapped_legacy_source_filename/);
});
