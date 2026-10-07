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
Unknown source profiles, any unreviewed unowned vacancy, count drift and
changed archive bytes fail before any target SQLite write.

For the frozen old-agent copy, `r03-private-legacy-binding.js` builds this
owner-only config from three verified sources: the final archive inventory,
the old agent's consistent cron SQLite backup, and each profile's
`active_vacancies` context inside the archive. Cron `profile_id` is the old
agent's canonical username/profile ID. The command requires all 11 disabled HH
jobs and 8 unknown outcomes, checks each cron vacancy against the same
profile's context, and rejects any candidate assignment to an unowned
vacancy. The operator supplies an exact expected count of historical-only
vacancies to quarantine. This is an explicit exclusion, never an ownership
grant. The private config records their IDs under
`quarantinedSourceVacancyIds`; an unused or unlisted exclusion fails preflight.

```sh
node src/r03-private-legacy-binding.js \
  --archive /private/final.tar --manifest /private/final-manifest.json \
  --inventory /private/final-inventory.json \
  --cron-db /private/cron.sqlite --cron-manifest /private/cron-manifest.json \
  --target-db /private/target.sqlite --scratch /private/scratch \
  --receipts /private/receipts --output /private/import-config.json \
  --expected-exclusions 1
```

Reviewed historical-only seen rows and snapshots retain their exact raw
payload under the source profile with `unowned_vacancy=1`; the private import
receipt counts them separately. They never enter `real_hh_seen`, accepted
snapshots or freshness. Candidate assignments and comments still require
target vacancy ownership.

Before an agent-owned target identity mapping is available, run the separate
private inventory command. It writes an owner-only file with source profile
refs, observed source vacancy IDs, per-profile counts and unresolved
`targetProfileId: null`. This is source evidence, not a binding. The operator
must obtain target profile and vacancy ownership from the agent's profile
authority; source names alone are insufficient evidence. The inventory stays
private because its identifiers can identify the customer.
The inventory entrypoint uses only Node built-ins and can run from an
owner-only staged source release without installing npm dependencies. The
SQLite import entrypoint still requires `better-sqlite3` to load successfully.

The candidate RU host has Node 20.20.2, Python 3.10.12 and Node headers. The
first 2026-10-06 `npm ci --omit=dev` attempt failed because `make`, `gcc` and
`g++` were absent. After an `apt-get -s` plan showed 31 additions and no
removals or upgrades, those build tools were installed. `npm ci --omit=dev` in
private staging and a host-side `require('better-sqlite3')` smoke check passed.
This proves only that the native addon loads in staging; it does not establish
that the web release, workers, mapping or live migration are ready.

```sh
node src/r03-private-legacy-inventory.js \
  --archive /private/initial.tar --manifest /private/manifest.json \
  --scratch /private/scratch --inventory-file /private/inventory.json
```

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
and receipt. If SQLite commits but writing the receipt file fails, the command
returns an error; rerun it with the same migration ID after fixing the private
receipt directory. The database replay then reconstructs the identical file
without writing duplicate content. The receipt contains per-file byte lengths
and SHA-256 values and must stay in the private directory. It does not indicate that a legacy search
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

For the 2026-10-06 migration, the initial archive was copied at about
05:29 UTC and the old VM stopped at 05:46:27 UTC. Those times leave an
unverified write window. The stopped disk is the frozen source: obtain a
verified final export from that disk or a ready snapshot before any final
import. Neither the initial inventory nor an initial-archive rehearsal can
prove that the final disk has no delta. Do not call the initial migration ID
final or promote its staged seen rows as final evidence.
