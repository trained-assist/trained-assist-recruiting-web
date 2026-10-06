# R-03 private legacy content import

The old HH skill writes four independent data families beneath a profile's
`proactive/` directory: `all-candidates.json`, `seen-ids.json`,
`search-results-*.json`, and `candidate-comments-<vacancy>.json`. Candidate
records may list several vacancy IDs. An empty `vacancy_ids` list means an
old wildcard record, not an authorized assignment to every vacancy.

`R03LegacyContentImporter` accepts parsed content from a **private** extractor.
The extractor/operator must bind the source profile to exactly one trusted
target profile and provide the target's vacancy ownership check. The import
validates every candidate, seen entry, snapshot reference and comment against
that binding, checks the expected row counts, and compares each parsed family
to its exact supplied source-file bytes. It writes all four families in one
SQLite transaction. A crash before commit leaves no imported rows. The same
migration/profile/content digest replays without duplication; changed content
or bytes under the same key conflicts. The receipt reports source filename,
byte length and SHA-256 for each supplied file. It proves the imported parsed
content matches those supplied bytes; the operator must separately verify that
these are the bytes captured from the old host.

Raw content stays in owner-only SQLite tables named `r03_legacy_content_*`.
Wildcard records and every old snapshot remain quarantined. The importer does
not populate the live candidate/seen/snapshot tables, create accepted manual
or scheduled receipts, activate schedules, or publish data to the page. This
prevents an old result with an unknown run outcome from looking like a fresh
accepted search. A later, explicit reconciliation must decide how to project
the old accumulated catalog and each snapshot into the new feed, including
legacy scores and per-vacancy review state. Its acceptance evidence must come
from the operator/source history rather than this import receipt.

The [private backup and restore runbook](R-03-PRIVATE-BACKUP-RESTORE.md) covers
that source-to-target byte check and final writer freeze. The public tests use
invented names, IDs and comments. No source profile ID,
candidate data, token, or private migration inventory belongs in this repo.
Before operating on real files, make a private immutable backup, record source
file byte digests, stop both old writers for the final delta, verify the target
counts/digests, and keep the old VM until the page and scheduled cycle pass.
