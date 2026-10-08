import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { R03LegacyContentImporter } from '../src/r03-legacy-content-import.js';
import { SqliteRealHhCandidateState } from '../src/sqlite-real-hh-candidate-state.js';

const profile = 'profile_invented';
const vacancy = 'vacancy_invented';
const secondVacancy = 'vacancy_second_owned';
const otherVacancy = 'vacancy_elsewhere';
const owned = (profileId, vacancyId) => profileId === profile && [vacancy, secondVacancy].includes(vacancyId);
const bind = source => source === 'source_invented' ? profile : null;
const copy = value => structuredClone(value);

function content() {
  const input = {
    migrationId: 'migration_invented', sourceProfileRef: 'source_invented',
    allCandidates: {
      resume_invented_bound: { id: 'resume_invented_bound', vacancy_ids: [vacancy],
        vacancy_data: { [vacancy]: { status: 'starred' } }, first_name: 'Вымышленная', source: 'search' },
      resume_invented_wildcard: { id: 'resume_invented_wildcard',
        first_name: 'Пример', source: 'manual' }
    },
    seenIds: { [vacancy]: { resume_invented_bound: '2026-10-01', resume_invented_wildcard: '2026-10-02' } },
    snapshots: [{ sourceFile: 'search-results-2026-10-03-vacancy_invented.json', payload: {
      vacancy_id: vacancy, searched_at: '2026-10-03T06:00:00.000Z', total_collected: 2,
      candidates: [{ id: 'resume_invented_bound', score: 8 }, { id: 'resume_invented_wildcard', score: 6 }]
    } }],
    comments: { [vacancy]: { resume_invented_bound: { text: 'Вымышленный комментарий', updatedAt: '2026-10-03T07:00:00.000Z' } } },
    globalComments: { resume_invented_wildcard: { text: 'Глобальная заметка без вакансии' } },
    expectedCounts: { allCandidates: 2, seenIds: 2, snapshots: 1, comments: 2,
      globalComments: 1, wildcardQuarantined: 1, quarantinedSnapshots: 1,
      unboundSeen: 0, mismatchedSeen: 0, unboundSnapshotMembers: 0, mismatchedSnapshotMembers: 0,
      unsafeSeenVacancyBuckets: 0, unsafeSeenRows: 0,
      snapshotFilenameMismatches: 0, unboundVacancySnapshots: 0,
      unboundComments: 0, mismatchedComments: 0,
      unboundReferences: 0 }
  };
  return withBytes(input);
}

function withBytes(input) {
  input.sourceFiles = Object.fromEntries([
    ['all-candidates.json', input.allCandidates], ['seen-ids.json', input.seenIds],
    ...input.snapshots.map(row => [row.sourceFile, row.payload]),
    ...Object.entries(input.comments).map(([vacancyId, value]) =>
      [`candidate-comments-${encodeURIComponent(vacancyId)}.json`, value]),
    ...(input.globalComments ? [['candidate-comments.json', input.globalComments]] : [])
  ].map(([file, value]) => [file, Buffer.from(JSON.stringify(value, null, 2))]));
  return input;
}

function fixture(t, onStep = () => {}, isQuarantinedSourceVacancy = () => false) {
  const directory = mkdtempSync(join(tmpdir(), 'r03-legacy-content-'));
  const filename = join(directory, 'private.sqlite');
  const opened = [];
  t.after(() => { for (const store of opened) if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { filename, open: () => {
    const store = new R03LegacyContentImporter({ filename, bindProfile: bind,
      isVacancyOwned: owned, isQuarantinedSourceVacancy, onStep });
    opened.push(store); return store;
  } };
}

test('explicit historical-only vacancy is retained as raw quarantined evidence', t => {
  const historical = 'historical_unowned';
  const input = content();
  input.seenIds[historical] = { resume_invented_bound: '2026-10-02' };
  input.snapshots.push({ sourceFile: `search-results-2026-10-04-${historical}.json`, payload: {
    vacancy_id: historical, searched_at: '2026-10-04T06:00:00.000Z',
    candidates: [{ id: 'resume_invented_bound' }] } });
  input.expectedCounts.seenIds++;
  input.expectedCounts.snapshots++;
  input.expectedCounts.quarantinedSnapshots++;
  input.expectedCounts.mismatchedSeen++;
  input.expectedCounts.mismatchedSnapshotMembers++;
  withBytes(input);
  const denied = fixture(t).open();
  assert.throws(() => denied.import(input), /invalid_legacy_content_seen/);
  denied.close();
  const { open } = fixture(t, () => {}, (profileId, vacancyId) =>
    profileId === profile && vacancyId === historical);
  const importer = open();
  const receipt = importer.import(input);
  assert.deepEqual(receipt.quarantine, { unownedVacancyIds: [historical],
    unownedSeenRows: 1, unownedSnapshots: 1 });
  assert.equal(importer.db.prepare('SELECT unowned_vacancy FROM r03_legacy_content_seen WHERE vacancy_id=?')
    .get(historical).unowned_vacancy, 1);
  assert.equal(importer.db.prepare('SELECT unowned_vacancy,acceptance_status FROM r03_legacy_content_snapshot WHERE vacancy_id=?')
    .get(historical).unowned_vacancy, 1);
  assert.equal(importer.db.prepare('SELECT quarantine FROM r03_legacy_content_import').get().quarantine,
    JSON.stringify(receipt.quarantine));
  assert.equal(importer.import(input).kind, 'replayed');
});

test('private import preserves invented content and quarantines wildcard and legacy snapshots', t => {
  const { filename, open } = fixture(t);
  const importer = open();
  const receipt = importer.import(content());
  assert.equal(receipt.kind, 'imported');
  assert.deepEqual(receipt.counts, content().expectedCounts);
  assert.match(receipt.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.sourceReceipts.length, 5);
  assert.deepEqual(receipt.sourceReceipts.map(row => row.file),
    ['all-candidates.json', `candidate-comments-${vacancy}.json`, 'candidate-comments.json',
      'search-results-2026-10-03-vacancy_invented.json', 'seen-ids.json']);
  assert.ok(receipt.sourceReceipts.every(row => row.bytes > 0 && /^[a-f0-9]{64}$/.test(row.sha256)));
  assert.equal(statSync(filename).mode & 0o077, 0);
  const wildcard = importer.db.prepare('SELECT wildcard_quarantined,payload FROM r03_legacy_content_candidate WHERE resume_id=?')
    .get('resume_invented_wildcard');
  assert.equal(wildcard.wildcard_quarantined, 1);
  assert.equal(JSON.parse(wildcard.payload).first_name, 'Пример');
  assert.equal(importer.db.prepare('SELECT acceptance_status FROM r03_legacy_content_snapshot').get().acceptance_status, 'quarantined');
  assert.equal(importer.db.prepare('SELECT text FROM r03_legacy_content_comment WHERE scope_status=?').get('bound').text,
    'Вымышленный комментарий');
  assert.equal(importer.db.prepare('SELECT text FROM r03_legacy_content_comment WHERE scope_status=?').get('unbound').text,
    'Глобальная заметка без вакансии');
  assert.deepEqual(JSON.parse(importer.db.prepare('SELECT payload FROM r03_legacy_content_comment WHERE scope_status=?')
    .get('bound').payload), content().comments[vacancy].resume_invented_bound);
  assert.equal(importer.db.prepare('SELECT COUNT(*) AS count FROM r03_legacy_content_seen').get().count, 2);
  importer.close();

  const active = new SqliteRealHhCandidateState({ filename, isVacancyOwned: owned });
  t.after(() => active.close());
  assert.equal(active.latestSnapshot(profile, vacancy), null, 'import cannot mint accepted current snapshots');
  assert.equal(active.seenTotal(profile, vacancy), 0, 'quarantined source seen dates cannot affect fresh-run counters');
});

test('exact replay is idempotent; changed content under same migration conflicts without mutation', t => {
  const { open } = fixture(t);
  const first = open();
  assert.equal(first.import(content()).kind, 'imported');
  first.close();
  const second = open();
  assert.equal(second.import(content()).kind, 'replayed');
  const changed = content();
  changed.comments[vacancy].resume_invented_bound.text = 'Другой вымышленный комментарий';
  withBytes(changed);
  assert.equal(second.import(changed).kind, 'conflict');
  assert.equal(second.db.prepare('SELECT text FROM r03_legacy_content_comment WHERE scope_status=?').get('bound').text,
    'Вымышленный комментарий');
  assert.equal(second.db.prepare('SELECT COUNT(*) AS count FROM r03_legacy_content_import').get().count, 1);
});

test('all four content families roll back together on injected failure', t => {
  let fail = true;
  const { open } = fixture(t, stage => { if (fail && stage === 'comments') throw new Error('invented_import_crash'); });
  const importer = open();
  assert.throws(() => importer.import(content()), /invented_import_crash/);
  for (const table of ['import', 'candidate', 'seen', 'snapshot', 'comment'])
    assert.equal(importer.db.prepare(`SELECT COUNT(*) AS count FROM r03_legacy_content_${table}`).get().count, 0);
  fail = false;
  assert.equal(importer.import(content()).kind, 'imported');
});

test('profile, vacancy, links, counts, duplicates and source filenames fail before writes', t => {
  const { open } = fixture(t);
  const importer = open();
  const cases = [
    input => { input.sourceProfileRef = 'unknown_source'; },
    input => { input.allCandidates.resume_invented_bound.vacancy_ids = [otherVacancy]; },
    input => { input.allCandidates.resume_invented_bound.vacancy_data[otherVacancy] = {}; },
    input => { input.seenIds[otherVacancy] = { resume_invented_bound: '2026-10-02' }; },
    input => { input.snapshots[0].payload.candidates[0].id = 'resume_invented_bound';
      input.snapshots[0].payload.vacancy_id = otherVacancy; },
    input => { input.snapshots.push(copy(input.snapshots[0])); input.expectedCounts.snapshots++; },
    input => { input.snapshots[0].sourceFile = '../search-results-evil.json'; },
    input => { input.comments[otherVacancy] = { resume_invented_bound: { text: 'Fake' } }; },
    input => { input.expectedCounts.seenIds = 1; }
  ];
  for (const mutate of cases) {
    const input = content(); mutate(input);
    assert.throws(() => importer.import(input));
  }
  assert.equal(importer.db.prepare('SELECT COUNT(*) AS count FROM r03_legacy_content_import').get().count, 0);
});

test('historical vacancy and snapshot filename mismatches stay quarantined with distinct counts', t => {
  const { open } = fixture(t);
  const importer = open();
  const input = content();
  input.seenIds[secondVacancy] = { resume_invented_bound: '2026-10-02' };
  input.snapshots[0].payload.vacancy_id = secondVacancy;
  input.comments[secondVacancy] = { resume_invented_bound: { text: 'Вымышленная заметка для другой вакансии' } };
  input.expectedCounts.seenIds++;
  input.expectedCounts.comments++;
  input.expectedCounts.mismatchedSeen++;
  input.expectedCounts.mismatchedSnapshotMembers++;
  input.expectedCounts.snapshotFilenameMismatches++;
  input.expectedCounts.mismatchedComments++;
  withBytes(input);
  const receipt = importer.import(input);
  assert.equal(receipt.kind, 'imported');
  assert.equal(receipt.counts.mismatchedSeen, 1);
  assert.equal(receipt.counts.mismatchedSnapshotMembers, 1);
  assert.equal(receipt.counts.snapshotFilenameMismatches, 1);
  assert.equal(importer.db.prepare('SELECT vacancy_mismatch FROM r03_legacy_content_seen WHERE vacancy_id=?')
    .get(secondVacancy).vacancy_mismatch, 1);
  assert.deepEqual(importer.db.prepare('SELECT acceptance_status,vacancy_mismatch_references,filename_vacancy_mismatch FROM r03_legacy_content_snapshot').get(),
    { acceptance_status: 'quarantined', vacancy_mismatch_references: 1, filename_vacancy_mismatch: 1 });
  assert.equal(importer.db.prepare('SELECT vacancy_mismatch FROM r03_legacy_content_comment WHERE vacancy_id=?')
    .get(secondVacancy).vacancy_mismatch, 1);
});

test('unsafe old seen bucket and snapshot without vacancy are retained only as private evidence', t => {
  const { open } = fixture(t);
  const importer = open();
  const input = content();
  input.seenIds['Вымышленная вакансия'] = { resume_invented_bound: '2026-10-01' };
  input.snapshots[0].payload.vacancy_id = null;
  input.expectedCounts.seenIds++;
  input.expectedCounts.unsafeSeenVacancyBuckets++;
  input.expectedCounts.unsafeSeenRows++;
  input.expectedCounts.snapshotFilenameMismatches++;
  input.expectedCounts.unboundVacancySnapshots++;
  withBytes(input);
  const receipt = importer.import(input);
  assert.equal(receipt.kind, 'imported');
  assert.equal(receipt.counts.unsafeSeenRows, 1);
  assert.equal(receipt.counts.unboundVacancySnapshots, 1);
  assert.equal(importer.db.prepare('SELECT unsafe_vacancy FROM r03_legacy_content_seen WHERE vacancy_id=?')
    .get('Вымышленная вакансия').unsafe_vacancy, 1);
  assert.deepEqual(importer.db.prepare('SELECT unbound_vacancy,acceptance_status FROM r03_legacy_content_snapshot').get(),
    { unbound_vacancy: 1, acceptance_status: 'quarantined' });
});

test('dangling historical references are preserved with quarantine markers', t => {
  const { open } = fixture(t);
  const importer = open();
  const input = content();
  input.seenIds[vacancy].resume_missing_old = '2026-09-30';
  input.snapshots[0].payload.candidates.push({ id: 'resume_missing_old', score: 5 });
  input.comments[vacancy].resume_missing_old = { text: 'Старая вымышленная заметка' };
  input.expectedCounts.seenIds++;
  input.expectedCounts.comments++;
  input.expectedCounts.unboundSeen++;
  input.expectedCounts.unboundSnapshotMembers++;
  input.expectedCounts.unboundComments++;
  input.expectedCounts.unboundReferences = 3;
  withBytes(input);
  assert.equal(importer.import(input).kind, 'imported');
  assert.equal(importer.db.prepare('SELECT unbound_reference FROM r03_legacy_content_seen WHERE resume_id=?')
    .get('resume_missing_old').unbound_reference, 1);
  assert.equal(importer.db.prepare('SELECT unbound_references FROM r03_legacy_content_snapshot').get().unbound_references, 1);
  assert.equal(importer.db.prepare('SELECT unbound_reference FROM r03_legacy_content_comment WHERE resume_id=?')
    .get('resume_missing_old').unbound_reference, 1);
});

test('long old comments are retained privately without imposing the new editor limit', t => {
  const { open } = fixture(t);
  const importer = open();
  const input = content();
  input.comments[vacancy].resume_invented_bound.text = 'Вымышленный '.repeat(150);
  withBytes(input);
  assert.equal(importer.import(input).kind, 'imported');
  assert.ok(importer.db.prepare('SELECT text FROM r03_legacy_content_comment WHERE scope_status=?')
    .get('bound').text.length > 1000);
});

test('source byte receipts require exact supplied JSON bytes for every family', t => {
  const { open } = fixture(t);
  const importer = open();
  const changed = content();
  changed.sourceFiles['all-candidates.json'] = Buffer.from('{}');
  assert.throws(() => importer.import(changed), /legacy_content_source_bytes_mismatch/);
  const missing = content();
  delete missing.sourceFiles['seen-ids.json'];
  assert.throws(() => importer.import(missing), /legacy_content_source_files_mismatch/);
  assert.equal(importer.db.prepare('SELECT COUNT(*) AS count FROM r03_legacy_content_import').get().count, 0);
});
