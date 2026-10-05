# R-03 manual search-run contract

## Legacy behavior inspected

The comparison source is `trained-assist-hh-skill` `origin/main` at `60566b5e9c4feee5e5a57ed1b2c93214082fb70`.

- `src/hh-routes.js` POST `/api/hh/proactive/search` starts the job using a server-resolved `username` and `vacancy_id`; GET on the same path polls by the same profile/vacancy and optional `job_id`. Both routes validate the profile token and scope the lookup before returning a public job.
- `src/hh-proactive-search-job.js` writes job JSON under the profile/vacancy proactive directory with temporary-file rename, sends progress callbacks, and uses a heartbeat while the search runs. A queued/running record older than five minutes is changed to failed on read rather than automatically replayed.
- Search work reports preparation, query generation, provider search, AI scoring and save phases. The final result includes `ai_pending_count`. The job maps this to `done` only when no AI scores remain; otherwise it reports `partial` even though the cold-search result snapshot was saved. Search completion and ATS refresh are therefore coupled in one state field.
- The legacy runner uses profile-bound HH credentials, LLM query generation, HH resume requests, scoring, persistent seen/candidate state and a durable result snapshot. This synthetic adapter intentionally imports none of that behavior.

## Synthetic HTTP contract

`POST /api/v1/ui/manual-search-runs` accepts the existing synthetic search request shape and an `Idempotency-Key`. The trusted profile comes only from the injected server resolver. The server verifies the fixture vacancy belongs to that profile and that the requested criteria revision is current before starting a run. A new operation returns `202`; an identical replay in the same process returns `200` with the same `runId`; a conflicting reuse returns `409`.

`GET /api/v1/ui/manual-search-runs/{runId}` returns the profile-bound run. `search.status` and its `phase`, completed-page count, result count and source revision describe provider search. `atsRefresh.status` is a separate field. On synthetic search completion it is `pending` with the result count as the refresh total. This expresses that ATS scoring is a later stage and is not evidence that a scorer is running here. The finished run includes `resultJobId` for the existing paginated synthetic results route.

The provider adapter may report `search_outcome_unknown`. That outcome is terminal, sets `automaticRetryAllowed: false`, and does not call the provider again on an idempotent POST replay. After a process restart, the run registry cannot prove whether an absent run was never created or lost while executing; an authorized poll therefore returns `410 run_outcome_unknown` and never silently retries. This fixture service has no durable idempotency store. A live provider must remain disabled until run state and idempotency are durable across restarts and unknown outcomes have a reconciliation path.

The new endpoint is intentionally separate from `/api/v1/ui/candidate-searches` and `/api/hh/proactive/search`, whose established request/response behavior is preserved. All new route responses are local synthetic fixtures; profile headers in tests stand in for a trusted resolver and are not production authentication.
