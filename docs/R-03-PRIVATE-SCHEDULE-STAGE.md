# Disposable legacy schedule stage

`r03-private-schedule-stage.js` checks the SHA-bound frozen archive, cron DB,
and private unknown-outcome audit before reading 11 legacy HH definitions.
It uses the explicit host profile mapping and existing legacy importer; it
accepts the old cron store's `succeeded` status without rewriting that source
value to `success`.

The command creates a new owner-only directory and SQLite backup of the
already imported candidate DB. It imports all definitions into that copy in
one transaction. All remain disabled and blocked; the eight old unknowns
keep `legacy_outcome_unknown` quarantine. No occurrence is created, replayed,
or claimed. A private receipt identifies the source hashes and marks the DB
`disposable_only` so it cannot be mistaken for the production migration DB.

The source import DB and cron DB are opened read-only. There is no timer,
provider call, web bind, or route change. An operator must review exact ATS,
query, credential, unknown-outcome and page/API readiness separately before
considering any schedule activation.
