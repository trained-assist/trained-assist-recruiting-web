# R-03 historical candidate evidence

The frozen legacy archive contains search-result files without an occurrence-bound
completion receipt or the source and criteria revisions required by the current
search contract. The importer preserves them in `r03_legacy_content_snapshot` with
`acceptance_status='quarantined'`. They cannot become `real_hh_snapshot`, change
`latest_completed`, raise `newCount`, or seed active seen rows through this plan.

`src/r03-private-historical-plan.js` reads the owner-only frozen archive and target
SQLite in read-only mode. For every imported snapshot it checks:

1. Exact migration/archive SHA-256 and byte count, and the imported per-file byte receipt.
2. Agent-owned profile/vacancy, filename vacancy, payload vacancy and timestamp.
3. Candidate list equality, explicit candidate-to-vacancy membership (no wildcard),
   and promoted seen with `first_seen_at` no later than the search timestamp.
4. Embedded ATS vacancy and presence of search queries. It records fingerprints of
   historical ATS and queries as evidence; these are **not** reconstructed revisions.
5. Current base plan readiness and exact ATS equality, only for a conservative
   recommendation of one latest historical file per ready owned scope.

Each file gets explicit reason codes. Every row remains historical-only even when
all checks pass. The private receipt contains file/profile/vacancy references and must
stay owner-only. Standard output contains aggregate counts only. The command creates
the receipt once (`0600`); exact replay succeeds, changed evidence at the same path
fails. It performs no DB writes or HH calls.

```sh
node src/r03-private-historical-plan.js \
  --import-config "$PRIVATE_IMPORT_CONFIG" \
  --host-config "$PRIVATE_HOST_CONFIG" \
  --output "$PRIVATE_HISTORICAL_RECEIPT"
```

The proposed page path, if later approved, must use an explicitly labelled
historical read model independent of the accepted feed. It must filter by trusted
profile/vacancy and byte-bound plan receipt, and must not expose blocked rows or
modify freshness, accepted snapshots, `newCount`, or active seen. Old candidate
payloads may contain personal data, so public fixtures and PRs use invented records.
