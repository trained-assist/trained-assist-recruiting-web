# R-03 private backup and restore runbook

Status: procedure only. This PR runs no command against either host, transfers
no candidate data, and activates no schedule.

## Capture and verify source bytes

1. Record the private profile binding, vacancy ownership map, expected file
   inventory and migration ID in the operator workspace. Keep IDs, names,
   comments, tokens, query text and paths out of public PRs and CI logs.
2. Make a first restricted backup of each source `proactive/` directory and
   relevant ATS/query files. Preserve filenames and bytes. Keep credentials in
   a separate restricted channel; this content importer must not receive them.
   Check for symlinks, malformed JSON and duplicate snapshot filenames before
   parsing. Calculate SHA-256 and byte length for every file from the backup.
3. Investigate the eight unknown schedule outcomes using preserved history.
   Keep all 11 old definitions paused. An imported old snapshot is never proof
   of a successful scheduled occurrence.
4. For the final delta, stop and verify both legacy writers: the search
   scheduler/manual search path and the separate five-minute scorer. Hold the
   public routes on the old host until the final copy and read comparison are
   complete. Capture a second backup and compare inventories and digests.
   Record the freeze time and who verified it privately.

## Stage on the target

5. Restore the final backup into an owner-only private directory on the target.
   Verify every restored file's byte length and SHA-256 against the final source
   manifest **before** JSON parsing. Count candidates, seen entries, snapshots,
   comments, ATS configs and query caches per profile; compare with the private
   inventory/rehearsal. Reject a missing, new or changed file rather than
   silently using the first backup.
6. Construct `R03LegacyContentImporter` input from the restored JSON bytes:
   `allCandidates` from `all-candidates.json`, `seenIds` from `seen-ids.json`,
   each `{sourceFile,payload}` snapshot, comments keyed by owned vacancy, and
   optional unscoped `globalComments` from `candidate-comments.json`.
   Pass the same bytes as `sourceFiles`, together with explicit
   `expectedCounts`, `bindProfile`, and `isVacancyOwned` ports. The importer
   verifies parsed objects against the bytes, then returns each file's byte
   length and SHA-256. Match every returned receipt to the private final source
   manifest. A replay must return the same digest/counts/receipts; a changed
   migration key is a conflict requiring investigation.
7. Verify the target SQLite integrity and row counts, plus a private sample of
   profile/vacancy scoped candidates, seen dates, snapshots and comments.
   Wildcard candidates, dangling historical references, unscoped comments and
   all legacy snapshots remain quarantined. Continue
   with explicit old-result reconciliation and accepted-receipt decisions;
   importing alone does not make the historical feed visible.

## Cutover and rollback

8. Check real HH and ladder access from the target with authorized credentials,
   run a manual canary, verify page/API links, and observe the full required
   scheduled cycle. Only then switch the public routes and activate reviewed
   schedules. Do not blindly replay the unknown occurrences. Keep the old
   scheduler disabled throughout and retain the old VM until the checks pass.
9. On any mismatch, leave new timers/routes disabled or restore the prior
   route, preserve both private backups and receipts, and investigate the
   exact file/row mismatch. The importer transaction rolls back an incomplete
   write; it does not reverse later operator promotion or a provider call.
