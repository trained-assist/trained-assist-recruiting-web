# R-04: accepted candidate report draft and private preview

This slice connects profile/vacancy-owned accepted candidate sources to a real HTTP/BFF draft workflow. `accepted_cold_search` requires the latest accepted cold-search snapshot; `accepted_hh_response` resolves an exact owned HH negotiation in `response` state, reads its resume without opening messages, and requires an existing accepted ATS assessment for the current resume and vacancy criteria. Both require active/starred review state. `report.createDraft` re-reads the selected source under the connected profile, pins its SHA-256 source revision, and copies only `clientDraftFields` into the report record. Internal assessment, salary, contact information, HH links, recruiter comments and ATS context are never copied into draft state or preview.

## Opt-in route set

- `GET /hh/candidate-report?vacancy_id=…&candidate_id=…[&source_kind=accepted_hh_response]` — connected-profile page. The default source kind is `accepted_cold_search`. A missing session enters the app's report step-up, which requests `recruiting.reports.read`, `recruiting.reports.create`, `recruiting.reports.edit` and `recruiting.reports.review`.
- `GET /api/v1/ui/accepted-report-client-source?...` — current client-safe source projection for the browser; internal assessment is stripped server-side.
- `POST /api/v1/ui/accepted-report-drafts` — create/replay an idempotent private draft. Identity comes only from BFF introspection; source revision and vacancy ownership are rechecked server-side.
- `GET /api/v1/ui/accepted-report-drafts/{reportRef}` and `/preview` — profile-owned state and escaped HTML, both fail closed if the accepted-source revision changes.
- `PATCH /api/v1/ui/accepted-report-drafts/{reportRef}/edit` — CSRF-protected optimistic edit of position, vacancy title and experience only. Candidate identity remains pinned to the accepted source; editing resets review, and an approved draft is locked.
- `POST /api/v1/ui/accepted-report-drafts/{reportRef}/review` — CSRF-protected human review decision with optimistic report revision and audit record.

The browser displays a sandboxed preview, lets the recruiter edit only allowlisted client fields, and can record internal review. This route set has no publish, revoke, share-link, client-delivery, HH-write or model-generation operation. The existing synthetic report lifecycle remains separate and is not a source for this path.

## Storage and privacy

`SqliteAcceptedReportDraftStore` is injected explicitly; there is no default mount. It requires an absolute database path in a private (0700) directory, a separate 32-byte hex encryption key, and a 0600 SQLite file. Every draft and audit record is AES-256-GCM encrypted. Owner and idempotency keys are keyed hashes; writes use immediate SQLite transactions and expected-revision checks. The private key must come from the deployment secret store and must never be written into config or logs.

The page uses a restrictive CSP and renders the preview in a sandboxed iframe. Unsafe HTTP requests go through the Connected App BFF's exact Origin and CSRF checks. The BFF session resolves the profile from current Control Plane introspection; browser-supplied profile IDs are ignored. The UI requires an explicit confirmation before saving review state. That confirmation is not permission to publish or send.

## Evidence and remaining acceptance

Synthetic HTTP tests exercise the real server/BFF/domain/SQLite handlers, profile isolation, source staleness, edit scope, CSRF, optimistic edit/review revisions, encrypted-at-rest and restart reads, privacy projection, HTML escaping, human approval, no PII-bearing log path, and absence of publish/send/provider calls. The opt-in private R-03 runtime now binds the HH-response ports to exact HH negotiation/resume reads, current base plan, accepted scheduled/manual assessment receipts and review overlay; [R-04 private runtime](R-04-PRIVATE-RUNTIME.md) describes the composition and its tests. The default host service remains unmounted. These tests do not prove a live CP issuer, reviewed profile membership, real accepted candidate source, production database key rotation/backup, product-approved client fields/consent, legacy notes/forbidden-phrase parity, or client publication/access policy. The UI must not be activated until those separate gates are accepted.
