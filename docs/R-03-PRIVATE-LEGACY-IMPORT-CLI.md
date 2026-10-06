# R-03 private archive to SQLite importer

The private CLI consumes an immutable archive captured by the
[backup runbook](R-03-PRIVATE-BACKUP-RESTORE.md). It extracts only
`agent-data/hh` into a temporary owner-only directory. It verifies the
archive byte length and SHA-256 against both a private manifest and a private
operator config before extraction. It rejects absolute/parent-traversal paths,
symlinks, hardlinks, duplicate members and unexpected top-level roots. The
temporary extraction is removed after either mode completes.

The config file and its parent directory must be owner-only. It specifies the
archive and manifest paths, target SQLite path, owner-only scratch and receipt
directories, migration ID, and an explicit source profile to target profile
mapping. Each mapped profile lists owned vacancy IDs and expected per-profile
counts from a separately reviewed private inventory. Every profile with
candidate, seen, snapshot or comment source files must be mapped exactly once.
Unknown source profiles, unowned target vacancies, count drift and changed
archive bytes fail before any target SQLite write.

With the config prepared privately on the target host:

```sh
node src/r03-private-legacy-import-runner.js --mode check --config /private/import-config.json
node src/r03-private-legacy-import-runner.js --mode import --config /private/import-config.json --execute
```

`check` verifies every source file against its supplied bytes and computes only
aggregate output. It creates a temporary preflight SQLite file in scratch and
does not open or create the target database. `import --execute` repeats the
checks, then imports all mapped profiles in one target transaction and writes a
private operation receipt. Repeating the same import reuses the durable rows
and receipt. The receipt contains per-file byte lengths and SHA-256 values and
must stay in the private directory. It does not indicate that a legacy search
was accepted. The CLI never activates a schedule, reads provider secrets from
the archive, calls HH/LLM, or publishes candidate data.

The first GCP backup is marked `initial_unfrozen`: old writers were still able
to change their source files. It can support a rehearsal, but a separate
final-frozen backup and new migration ID are required before cutover. That
final copy must follow the writer-freeze procedure and use a separate archive
and target receipt. This importer stages candidate content only; ATS context,
query caches and credentials need their own verified target binding before a
live search. Historical snapshots remain quarantined; seen ledger promotion
and historical feed reconciliation are separate explicit steps.
