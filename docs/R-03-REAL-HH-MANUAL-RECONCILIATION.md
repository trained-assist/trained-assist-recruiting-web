# R-03 real-HH manual unknown reconciliation (offline)

`SqliteRealHhManualReconciler` handles the manual-run crash window: the real-HH candidate snapshot committed, but the durable manual run remained `outcome_unknown`. It is an operator-only domain operation with authorization and vacancy-ownership callbacks that default to deny. No HTTP/MCP route, provider call, candidate rewrite or automatic retry is added.

The operator supplies the run/job IDs, profile, vacancy, criteria revision, source revision, result revision, result count, reason code and idempotent operation ID. The reconciler requires an exact deterministic job ID, an unknown run bound to that profile and vacancy, and a committed `manual` snapshot with matching criteria/source/result/count and a search timestamp between run start and reconciliation. The run update and versioned audit receipt share one SQLite `BEGIN IMMEDIATE` transaction. If the receipt write fails, the run stays unknown. A repeated identical operation returns the same receipt; a changed operation or second operation for the run conflicts.

After reconciliation, the accepted-manual-receipts port from the prior slice can expose this result to the accumulated feed. The snapshot keeps its original `searchedAt`; reconciliation time does not make old candidates newly searched. Tests use invented candidates and cover restart-style unknown state, cross-scope and revision rejection, missing snapshot, idempotency, audit rollback and no provider replay. The receipt schema is `contracts/v1-real-hh-manual-reconciliation-receipt.schema.json`.

This does not create production operator identity, a CLI, or a public route. Unknown results without exact committed snapshots remain blocked for investigation. HH #187 remains the GCP VM stop gate.
