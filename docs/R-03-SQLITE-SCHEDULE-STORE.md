# R-03 durable schedule and occurrence store

`SqliteColdSearchScheduleRepository` implements the existing synchronous
schedule repository port with a local SQLite database. The intended topology
is one HH service host, with a web process and a minute timer worker opening
the same database file on a local filesystem. It is an implementation slice,
not a production worker or cutover. Do not put the database on NFS or run
workers on different hosts against copied files.

## Atomicity and recovery

- SQLite WAL, `synchronous=FULL`, a 5-second busy timeout, and `BEGIN IMMEDIATE`
  serialize the due claim across connections. In one transaction, the adapter
  quarantines expired running work, chooses due slots, inserts occurrences,
  and advances `nextRunAt`.
- The database enforces `UNIQUE (legacy_job_id, scheduled_at)` independently of
  generated occurrence IDs. A missed window is coalesced into its latest due
  slot. A conflicting slot is never executed again.
- A terminal outcome is accepted only while the occurrence and schedule both
  hold the same worker lease and its expiry is strictly after the finish time.
  A late result is rejected. The next claim changes expired work to
  `outcome_unknown` and blocks its schedule; a human reconciliation path is
  required before it can run again.
- The database file is chmod `0600` on open. The adapter rejects a database
  directory with group or other permissions, so SQLite's `-wal` and `-shm`
  sidecars remain private even if their individual modes are broader. Deploy
  it in a service-owned `0700` directory, back up with SQLite's online
  backup API or a stopped service, and keep its WAL/SHM beside it. Opening a
  database is not a migration of actual legacy schedule identities.

`node --test test/sqlite-cold-search-schedule-repository.test.js` covers a
close/reopen, two connections racing for the same due slot, expired lease
quarantine, late finish fencing, duplicate-slot suppression, a late enable
after a completed tick, private-directory enforcement, and missed-run
coalescing with a synthetic clock. `npm test` runs this with the rest of the
synthetic service suite. The adapter requires Node 20+ and `better-sqlite3`,
whose native module must be built or installed for the deployment CPU/OS.

## Remaining stop-gate work

The schedule command still creates synthetic `legacyJobId` values and uses
fixture vacancies/criteria. The actual 11 legacy definitions and eight
unknown outcomes need a private, reviewed import/reconciliation; do not infer
success or replay from this store. This repository still needs a periodic
timer, lease renewal or bounded worker runtime, a reconciliation command and
audit trail, durable candidate-search jobs/results and provider idempotency,
real HH credentials/profile data, the background scorer, and production route
cutover. A durable occurrence can coexist with a process-local search result,
so this slice alone cannot satisfy the morning-candidates scenario or the GCP
VM stop gate in [HH #187](https://github.com/trained-assist/trained-assist-hh-skill/issues/187).
