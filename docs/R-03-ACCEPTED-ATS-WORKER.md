# Accepted HH snapshot ATS worker

The private host `--mode score` consumes the durable accepted-assessment queue in the same SQLite database as HH schedules, manual runs and candidate snapshots. It enumerates every configured profile/vacancy binding, including disabled schedules and older accepted snapshots. Only exact successful scheduled or manual receipts make a snapshot eligible. Unknown search outcomes never enter the queue.

The five-minute worker uses the real ATS evaluator and free-ladder HTTP adapter. It loads private vacancy criteria without query regeneration or HH token access. The score systemd service receives only `ladder_token`; no browser session, Agent Run, HH credential or public route can invoke this mode. The unit remains an uninstalled template.

At most six model dispatches are reserved per five-minute UTC window across all scopes and processes. Reservations are committed before the provider call and survive restart. A provider error or expired lease is `outcome_unknown` and is never automatically sent again; an unavailable criteria plan before dispatch is deferred. Each invocation has a 285-second application deadline beneath the unit's five-minute timeout. The queue claims no more than ten rows per tick, with the stricter six-dispatch host budget governing live throughput.

Within one scope, one third of claims take the oldest eligible rows. The remainder prefer newer snapshots, then higher pre-score, with stable job/resume tie breaks. The host divides the current window budget among configured scopes before giving unused capacity to a scope with more work. This gives the morning page useful assessed candidates early while old accepted snapshots continue making progress.

For the disposable 1,688-candidate snapshot from #79, six calls every five minutes yield a **minimum** of 282 five-minute windows, or about 23 hours 30 minutes, before all could be assessed, assuming every call succeeds and there is no competing scope. The morning page therefore reports `assessment_pending` and counts rather than claiming all candidates are scored. Actual time may be longer. A later rate or budget change needs its own provider cost and latency review.

Tests drive the real private CLI, accepted receipt, candidate SQLite state, ATS evaluator and ladder HTTP adapter with an invented external response. Further tests cover older snapshots, cross-profile scope, restart, unknown outcomes, shared window cap, fresh/high-score selection and old-backlog progress. No real provider or production database is used.

This PR is an offline worker and service template. Before activating the timer, verify reviewed profile/vacancy ownership and criteria for every scope, expected backlog and ladder rate, accepted receipt reconciliation, private host credentials, and a timed natural cycle on the RU host. Public-route cutover and GCP VM shutdown remain separate gates.
