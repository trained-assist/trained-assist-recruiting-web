# R-03 morning candidate page foundation

The user's first visible outcome is opening `/hh/proactive?vacancy_id=...` in the morning and seeing accumulated candidates for the trusted profile and vacancy, with freshness from the latest completed search. This slice implements that path with synthetic data. The page uses a same-origin API, renders candidate text with DOM `textContent`, and has buttons to enable/disable a schedule or start a manual search. A strict CSP, `no-store`, trusted injected profile context and vacancy ownership checks apply to the page and APIs. No username or token in a query/body selects the profile.

The scheduled minute tick and the manual `/api/hh/proactive/search` route invoke the same candidate-search handler and job store. Successful completions now atomically update the synthetic candidate pool, seen IDs and dated snapshot. The candidate read shows the accumulated pool for the owned vacancy; the latest completed snapshot supplies freshness, source and new-count metadata. It returns `never_run` before one exists and never presents a partial job as fresh. A manual `Idempotency-Key` keeps a retry on the same job and original search time; concurrent requests with the same key share one in-flight operation. The test advances a fake clock, runs a scheduled search, reads synthetic candidates from the page API, then performs and replays a manual search with no second provider call.

| Legacy public path/action inspected at `trained-assist-hh-skill` revision `af25f267bd20498c02f578b7b77ffc587dad3e85` | This slice |
|---|---|
| `GET /hh/proactive` | Synthetic page requires trusted context and explicit `vacancy_id`; old `username`/HMAC link handoff is not yet migrated |
| `GET /api/hh/proactive/candidates` | Synthetic accumulated feed and latest completed snapshot for one authorized vacancy |
| `POST /api/hh/proactive/search` | Synthetic manual search through shared handler; exact legacy response payload is not yet compatible |
| `POST /api/hh/proactive/vacancy-state` | Enable/disable only; star/archive and related UI state remain open |
| `GET/POST /api/hh/proactive/prompt` | Open: editable per-vacancy queries and query cache |
| `POST /api/hh/proactive/comment`, `/set-status`, `/import-seen`, `/add-manual`, `/ai-score` | Open: routes for review actions, seen import, manual add and background scoring; state model exists but these actions are not connected |
| New `GET /api/hh/proactive/schedule`, `/occurrences` | Synthetic schedule and occurrence reads for the page and contract exercise |

This is a route and page foundation, not public URL cutover. The existing nginx routes still point to the old GCP VM. Optional SQLite adapters now persist jobs, schedules and candidate/seen/snapshot state for synthetic runs; defaults remain in memory. The new page cannot yet use real HH credentials, migrated profile data, the five-minute rescore writer or trusted production web session. Legacy link compatibility and full API behavior need reviewed adapters; no URL routing or live job was changed. HH issue #187 remains the stop gate: accept every required vacancy schedule, including a full cycle of the rarest schedule, on a verified non-GCP host before the old VM can stop.
