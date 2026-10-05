# R-03 schedule and occurrence foundation

This slice implements only the synthetic app-owned schedule boundary and due occurrence worker. It is not a replacement worker and does not satisfy the GCP VM stop gate in [issue #187](https://github.com/trained-assist/trained-assist-hh-skill/issues/187). Architecture PR [#154](https://github.com/trained-assist/trained-agent-architecture/pull/154) is merged and records that the cold-search capability, user results page/API, profile data/credentials, and five-minute rescore writer must all be cut over and verified before stopping the VM.

## Legacy behavior inspected

Inspected `trained-assist-hh-skill` at local HEAD `af25f267bd20498c02f578b7b77ffc587dad3e85` (read-only):

- `src/hh-cold-search-cron.js`: `hh_proactive_schedule` upserts one core cron job per vacancy named `cold-search:<vacancyId>`, action `hh_proactive_search`, timezone `Europe/Moscow`, and arguments containing only `vacancy_id`. Stable string hashing spreads jobs by vacancy. `interval_hours` is rounded to one of the supported intervals: sub-hour schedules become twice hourly (effective 0.5 hours); sub-24-hour schedules snap to 1/2/3/4/6/8/12 hours; longer intervals become a day step. Daily runs are spread between 07:00 and 18:59 Moscow.
- `src/hh-cold-search-lock.js`: the old service uses a filesystem `wx` lock scoped to profile; live PID or recent lock means busy, dead/old lock is reclaimed.
- `src/mcp-skills/tools/92-hh-proactive.js`: the command takes `USER_ID` from server environment, vacancy from the command or selected profile vacancy, and exposes enable/disable/status. It warns when this host is not the active scheduler.
- `src/hh-routes.js`: `/api/hh/proactive/vacancy-state` is the UI route that enables/disables and tracks vacancy UI state; `/api/hh/proactive/search` is the manual-search route and calls the same `runProactiveSearch` implementation used by scheduled `hh_proactive_search`.
- `tests/hh-cold-search-cron.test.js`: pins interval rounding, stable spread, per-vacancy job identity, `Europe/Moscow`, and wrapper status/disable behavior.

The legacy schedule action writes core cron state; the legacy UI vacancy-state route also tracks profile-local `schedule.json` metadata. The new slice does not copy either storage layout. Legacy uses a profile-wide filesystem lock; this boundary models a row lease plus unique occurrence key and must be backed by an atomic durable repository before deployment.

## Synthetic domain boundary

`createColdSearchScheduleHandler` accepts a `recruiting.candidateSearch` trusted context. The command schema has no profile or token field; the profile comes from the injected trusted context. The schedule row stores the trusted profile owner and fixture search criteria. Its worker arguments contain only `vacancyId`; credentials and profile identity are not placed in job arguments. A bounded deterministic plan reproduces the legacy interval classes and vacancy-specific spread in `Europe/Moscow`.

The minute tick asks the repository to atomically lease due schedules, insert an occurrence under unique `(legacy_job_id, scheduled_at)`, and advance the next due slot. Several overdue slots collapse into one occurrence with a `coalescedMissedCount`. Re-enabling an already-due schedule preserves its due slot so the worker coalesces it instead of silently skipping it. At each due tick, the worker resolves current synthetic criteria for the trusted profile/vacancy again; edits after enable are reflected in the occurrence's `criteriaRevision` and search request. The worker invokes the same `candidateSearchJobs.start` handler and in-memory job store as the manual HTTP route, then resumes bounded retryable pages (four resume calls maximum) and records a result snapshot only after job status is `completed`. A partial, failed, or otherwise incomplete search never produces a successful occurrence. It does not write a second candidate store or report candidates as seen/applied.

The repository port must make due claim, lease, unique insert and next-run advancement one durable transaction. The current `InMemoryColdSearchScheduleRepository` is a stateful test adapter only. A thrown/failed provider call or expired worker lease becomes `outcome_unknown`; the owning schedule is quarantined, a late worker cannot overwrite the outcome, and no second execution can start after lease expiry. An occurrence is not blindly replayed. There is no reconcile endpoint or periodic process timer yet, so live deployment is blocked until the durable adapter has lease renewal/fencing plus a safe reconciliation path and tested idempotency semantics and an external minute event invokes the worker.

The generated `legacyJobId` here is synthetic and namespaced with a one-way profile digest plus fixture vacancy ID. It is only a test uniqueness key; it cannot stand in for the imported legacy cron/job IDs needed for a real `(legacy_job_id, scheduled_at)` migration. Production migration must persist a reviewed mapping from each actual legacy ID to its new schedule row.

## Offline workflow and contract gap

`npm run test:offline` executes the real schedule domain handler and actual candidate-search handler with a stateful fake repository, fake clock, synthetic two-page provider, and explicit test profile contexts. A static import/call guard verifies these runtime modules do not import a runner or contain Agent Run launch calls. Tests cover schedule isolation by profile/vacancy, command scope, interval/timezone mapping, one occurrence across overlapping ticks, missed-run coalescing, expired in-flight lease quarantine, unknown provider outcome without replay, and visibility of the scheduled fixture job through the same job/result API used by manual search.

The command and occurrence shapes have checked JSON Schemas, and the offline command calls the domain handler directly. This is a **domain-offline foundation**, not an MCP round-trip or registered MCP façade. It also has no user-facing schedule routes; adding the MCP adapter, contract-derived mock dependencies, supported command dispatch, and UI parity is separate work. This follows the offline scenario direction in open architecture PR [#157](https://github.com/trained-assist/trained-agent-architecture/pull/157), but does not claim MCP compliance or a user-facing schedule feature.

## Production gaps and stop gate

- Durable transactional schedule/occurrence store, lease renewal/fencing, multi-worker safety, and reconciliation of unknown outcomes.
- Trusted identity and profile-to-vacancy authorization, canonical criteria/context revisions, credentials, provider access, limits/retries, and snapshot persistence.
- User-facing schedule UI/API and an actual MCP command registration with contract parity; parity for enable/disable/status and history.
- Migration of profile schedule/query cache/seen IDs/candidate stores/snapshots and reconciliation of legacy unknown statuses.
- Full candidate results page/API parity, manual and scheduled behavior against the live provider, and migration/stop of the independent five-minute background rescore writer.
- Operational target, systemd minute timer/service identity, logging, resources, rollback, and a full rare-interval observation.

No legacy jobs were enabled or changed, no VM was accessed, no live provider or profile state was read, no deploy was performed, and no production credentials or candidate PII are present here. The GCP VM must remain running until issue #187 acceptance is complete.
