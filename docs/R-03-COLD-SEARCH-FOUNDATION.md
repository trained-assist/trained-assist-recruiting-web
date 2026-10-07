# R-03 cold-search foundation

This is a bounded synthetic job/result slice, not complete R-03. Routes are local UI fixtures and are omitted from C14 manifest/capability discovery. The default trusted-profile resolver denies access; a host must inject trusted out-of-band identity/scope and a current criteria revision resolver. The test resolver is a stub, not application authentication.

`POST /api/v1/ui/candidate-searches` requires an `Idempotency-Key`, vacancy, criteria revision, and bounded synthetic criteria. Idempotency is profile-scoped using an encoded `(profileId, key)` tuple; retrying the same key and request returns the same job, while changing the request under an existing key conflicts. The current criteria revision resolver is mandatory: a missing, invalid or failing resolver returns `503` and blocks start/read/resume, while a changed revision returns `409`. A fake provider returns one page per call. Only a clean partial page or a partial page with a retryable provider error can resume; provider 403 is non-retryable even after earlier pages and is never represented as an empty successful result. Non-advancing provider cursors are rejected. Result pages use cursors pinned to the current result snapshot; resuming and appending results invalidates an older cursor. The service caps requests at 16 KiB, jobs at 100 per process, provider pages at 50 records, and each job at 200 results.

The adapter preserves provider order and explicitly labels it `provider_order_unranked`. No scoring or ranking policy is implied. Job state is in memory in this process only; it demonstrates a resumable contract within the process lifetime, not recovery after process restart. No candidate is marked seen, reviewed, imported, or moved into an HH negotiation. There is no review mutation endpoint, durable persistence, live HH/provider request, token, LLM, or candidate PII. The fixture, provider revision, criteria, and candidate records are synthetic.

## Legacy comparison

Inspected `trained-assist-hh-skill` at `af25f267bd20498c02f578b7b77ffc587dad3e85` (local `main`; 17 commits behind `origin/main` during inspection), especially `src/hh-proactive-search.js` (`runProactiveSearch`), `src/hh-cold-search-transport.js`, `src/hh-cold-search-snapshots.js`, and `src/hh-routes.js` (`/api/hh/proactive/search`). The legacy path resolves profile-file vacancy/ATS context, requires a profile HH token, generates/caches search queries through the LLM ladder, performs GET `/resumes` queries, keyword-scores then ATS/LLM-enriches candidates, merges profile JSON candidate/seen stores, and writes durable dated snapshots for a review page. The associated route reports provider failures, including access denied, separately from result counts. Legacy seen state is written per profile/vacancy and candidate state/comments are persisted.

This foundation does not port those coupled behaviors. It uses a synthetic fixed query/page adapter, typed bounded provider errors, process-local job maps, and provider-order results. It does not implement ATS scoring, LLM query generation/enrichment, persistent snapshots, seen-state merge, review status/comments, manual candidates, import, notifications/scheduling, access-token refresh, or the HTML review page.

## Production decisions still open

- Identity-to-profile mapping, scope grant and credential broker/token owner.
- Provider selection, query semantics, request limits, quotas, retry/backoff, timeout and cursor guarantees.
- Authoritative criteria/source revision owner, stale-result policy, and durable job/result store with restart recovery.
- Canonical score/evidence policy, merge/seen semantics, retention and privacy controls.
- Whether manually sourced candidates join the same pool; what review state, comments and import transitions are allowed and audited.
- How a search candidate becomes an accepted application/negotiation; this slice does not represent a candidate as applied.
