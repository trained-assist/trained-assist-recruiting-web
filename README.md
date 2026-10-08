# trained-assist-recruiting-web

Independent recruiting application and versioned platform contracts.

## Initial service and R-01 foundation

This repository owns the recruiting domain boundary. The platform/agent can consume the versioned HTTP contract without importing recruiting implementation code. The default local server uses synthetic fixtures and process-local state. The opt-in private R-03 stack has durable SQLite storage and host templates; it is not installed on the RU host or connected to the public route.

Run locally with Node.js 20 or newer:

```sh
npm start
```

It binds only to `127.0.0.1` (default port `3000`, optionally selected with `PORT`). Open `http://127.0.0.1:3000/` for the small browser index.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health/ready` | Process readiness |
| GET | `/api/v1/readiness` | Versioned readiness and checked local release/version tuple |
| GET | `/api/v1/manifest` | Service manifest and endpoint map |
| GET | `/api/v1/capabilities` | Typed capabilities and their API schema references |
| GET | `/api/v1/vacancies` | Synthetic vacancy fixture list |
| GET | `/api/v1/profiles/{profileId}/vacancies` | **Local UI fixture-only** synthetic profile vacancies; not advertised in the C14 manifest/capability registry |
| GET | `/api/v1/profiles/{profileId}/vacancies/{vacancyId}/responses` | **Local UI fixture-only** paginated synthetic response summaries; not advertised in the C14 manifest/capability registry |
| GET | `/api/v1/ui/report-previews?candidateId=…&vacancyId=…` | **Local UI fixture-only** synthetic client report preview; no save, publish, or share operation |
| GET | `/hh/candidate-report?vacancy_id=…&candidate_id=…` | **Opt-in R-04** accepted-source report preview and human review; requires connected BFF and encrypted draft store; no publish/send route |
| POST/GET/PATCH | `/api/v1/ui/accepted-report-drafts` and `/api/v1/ui/accepted-report-drafts/{reportRef}[/preview|/edit|/review|/regenerate|/export]` | **Opt-in R-04** profile-owned accepted candidate draft, allowlisted edits, provenance and private review state; regenerate requires an injected generation adapter; export is a private revision-bound download after current approval |
| GET | `/api/v1/ui/accepted-report-previous-approved?candidateId=…&vacancyId=…[&excludeReportRef=…]` | **Opt-in R-04** latest immutable, encrypted approved version in the authenticated profile/candidate/vacancy scope |
| POST | `/api/v1/ui/report-drafts` | **Local UI fixture-only** profile-scoped synthetic draft creation; requires source revision and idempotency key |
| GET/PATCH | `/api/v1/ui/report-drafts/{reportRef}` | **Local UI fixture-only** private draft state and allowlisted client-field edit |
| GET | `/api/v1/ui/report-drafts/{reportRef}/preview` | **Local UI fixture-only** escaped private client-audience preview |
| POST | `/api/v1/ui/report-drafts/{reportRef}/review` | **Local UI fixture-only** explicit profile-scoped review decision |
| POST | `/api/v1/ui/report-drafts/{reportRef}/publish` | **Local UI fixture-only** publish through an injected server-side policy/authorization adapter; default denies; returns receipt only |
| POST | `/api/v1/ui/report-drafts/{reportRef}/revoke` | **Local UI fixture-only** revoke through the injected adapter; no public sharing URL exists |
| POST | `/api/v1/ui/candidate-searches` | **Local UI fixture-only** synthetic cold-search job start; requires injected trusted profile context and an idempotency key |
| GET | `/api/v1/ui/candidate-searches/{jobId}` | **Local UI fixture-only** synthetic search job status; in-memory for this process only |
| GET | `/api/v1/ui/candidate-searches/{jobId}/results` | **Local UI fixture-only** cursor-paginated synthetic search results |
| POST | `/api/v1/ui/candidate-searches/{jobId}/resume` | **Local UI fixture-only** resume a partial/retryable fixture job |
| GET | `/hh/proactive?vacancy_id=…` | **Local synthetic page** showing the accumulated candidate feed and latest completed search metadata for a trusted profile and vacancy |
| GET | `/api/hh/proactive/candidates?vacancy_id=…` | Accumulated profile-owned candidate feed with latest completed synthetic snapshot |
| GET | `/api/hh/proactive/schedule?vacancy_id=…`, `/api/hh/proactive/occurrences?vacancy_id=…` | Profile-scoped schedule and occurrence status |
| POST | `/api/hh/proactive/vacancy-state`, `/api/hh/proactive/search` | Synthetic enable/disable and manual run through the shared R-03 handlers |

JSON Schemas live in `contracts/`. The C14 manifest advertises only the unscoped synthetic vacancy list; profile, report and candidate-search routes are intentionally absent from its capability registry and endpoint map until trusted out-of-band context exists. The manifest otherwise follows the proposed C14 connected application contract: stable `serviceId`, release/source revision/environment, bounded platform contract range, domain API version, typed capabilities, compatibility declarations, and typed readiness with a checked version tuple. The current readiness reason explicitly limits this fixture service to local synthetic use. CI validates manifest, vacancy, local profile-slice, report sources/previews/lifecycle states, and search jobs/results against the checked in JSON Schemas (`ajv`) and exercises HTTP behavior with Node's built in test runner (`npm test`). Only documented local fixture job/draft state changes are accepted; no production state mutations exist. Unsupported methods return `405`.

The browser demo demonstrates selecting a fixture vacancy and reading synthetic response summaries. Its local-only routes send `X-Demo-Profile-Id`; the service checks the fixture profile match, declared fixture scope, and vacancy assignment. The header and scope map are spoofable test scaffolding, **not authentication**, and the routes are not an agent capability. There is no trustworthy user identity, tenant boundary, credential broker, session handling, or production scope grant here. A future adapter must supply trusted profile context out of band before these routes can enter the C14 capability registry or serve real profile data. Response pages return a stable `revision` and `freshness: current`; cursors pin profile, vacancy, revision, and offset. A cursor from a different revision returns `409` with `freshness: stale` and the current revision so the UI can restart. Fixtures contain only fake IDs, status, and timestamps; no candidate names, contact details, or free text.

This is an **R-01 foundation**, not completion of the production scenario. Actual identity-to-profile mapping, tenant semantics, response meaning/fields, trusted scope grants, and freshness guarantees from a live canonical store remain open under issue #3.

An additional [R-01 live HH response read slice](docs/R-01-LIVE-RESPONSE-READ.md) binds one HH `response` page to the opt-in private Connected App BFF runtime through its profile credential broker and owned vacancy map. The queryless Connected App entry offers a static feature chooser; its `/hh/responses` page and `/api/v1/ui/hh-responses` API request `recruiting.responses.read` only through an explicit step-up. They are absent from the demo, public route and C14 capability registry; page-level revision and best-effort pagination state their limits explicitly.

The [R-04 accepted report source slice](docs/R-04-ACCEPTED-SOURCE.md) projects a currently assessed candidate from the accepted cold-search feed into separate client draft and internal fields. The [accepted-source draft and private review slice](docs/R-04-ACCEPTED-DRAFT.md) connects that projection to encrypted SQLite draft state and a BFF-protected preview/edit/review page. The stacked #108 work adds scoped recruiter instructions, field provenance, explicit regeneration over an injected generator port, and encrypted snapshots of approved versions shown on the next draft. It requires explicit source, BFF, encrypted store and generator injection; default server construction and the private R-03 host do not mount it. Publication and sending remain unavailable.

The R-04 draft flow also accepts the `accepted_hh_response` source kind: it resolves an exact profile-owned HH negotiation in `response` state, loads the associated current resume and already accepted ATS assessment, and feeds the same revision-pinned private draft/edit/review lifecycle. Editing has its own `recruiting.reports.edit` scope; it can change only position, vacancy title and experience, resets review, and is optimistic on report revision. The private R-03 runtime composes those ports and encrypted draft storage only when started with an explicit `--report-drafts-db` path alongside Connected App BFF configuration; the default systemd unit does not load the report key or mount report routes. See [R-04 accepted draft](docs/R-04-ACCEPTED-DRAFT.md) and [R-04 private runtime](docs/R-04-PRIVATE-RUNTIME.md). Live RU activation remains a separate gate.

Opening a response conversation has a provider-visible “may mark viewed” effect. The GET route only renders a confirmation page; history loads after a CSRF-protected POST and requires both `recruiting.responses.read` and separate `recruiting.responses.conversation.open` scope. See [the R-01 conversation contract and limits](docs/R-01-LIVE-RESPONSE-READ.md#explicit-conversation-history-r-01-follow-up).

The opt-in [R-01/R-04 Connected App BFF boundary](docs/R-01-R-04-CONNECTED-BFF.md) handles a Control Plane authorization code with PKCE, keeps the access token server side and rechecks profile scope on each read. It is an unmounted synthetic integration until the platform login authority, durable BFF store and live issuer are accepted.

The client report preview uses a hand-written synthetic source fixture. Its internal source and client view have separate schemas; the client view is an explicit field allowlist. The preview HTML is deterministic, escapes all fixture text, carries the synthetic source revision, and is visibly marked as a draft not for sending. The route is a local UI GET and is not listed in C14 capabilities or manifest endpoints. There is no write, publish, download, or sharing route.

The R-03 cold-search foundation uses a synthetic provider and a shared scheduled/manual job handler. The default job, schedule, occurrence and candidate stores are in memory. Optional SQLite adapters persist jobs/results and schedules/occurrences on one host; the candidate/seen/snapshot adapter is described in `docs/R-03-SQLITE-CANDIDATE-STATE.md`. A completed search updates the candidate pool and seen ledger before publishing a dated snapshot. `/hh/proactive` and `/api/hh/proactive/candidates` show the accumulated feed with freshness from the latest completed snapshot. `npm run test:offline` and `npm run test:offline:mcp` exercise the scheduler and MCP contract with synthetic dependencies. The app has no live HH credential, provider, production identity, public routing or background scorer. Unknown/lease-expired work is quarantined until reconciled. The GCP VM stop gate remains open under HH issue #187. See `docs/R-03-COLD-SEARCH-FOUNDATION.md`, `docs/R-03-SQLITE-SEARCH-JOBS.md`, `docs/R-03-SQLITE-SCHEDULE-STORE.md`, `docs/R-03-CANDIDATE-STATE-FOUNDATION.md`, `docs/R-03-OFFLINE-RECONCILIATION.md` and `docs/R-03-MORNING-PAGE-FOUNDATION.md`.

The public synthetic browser sandbox ingress is `https://trained-assist-recruiting-web-sandbox-bridge.skillset-apply.workers.dev/__sandbox-login`. It proxies to the local synthetic app through the current Cloudflare Quick Tunnel; it has no production identity, provider, or candidate data. Source and configuration are `src/sandbox-edge-proxy.js` and `wrangler.sandbox-edge-proxy.toml`. If the Quick Tunnel hostname changes, update `UPSTREAM_ORIGIN` and redeploy with Wrangler 4; the stable Worker hostname does not keep the local app process alive. This edge bridge is browser ingress, not the production MCP relay. Agent Runner-facing schedule capability semantics are checked by `npm run test:offline:mcp` using synthetic dependencies.

An opt-in [R-03 synthetic minute worker](docs/R-03-MINUTE-WORKER.md) now opens the schedule, job and candidate-state SQLite stores on one host, checks a fixed fake profile/vacancy binding, and runs one bounded tick under a singleton lease. Its checked-in systemd unit/timer are disabled templates for fixture runs only; they do not connect HH or satisfy the GCP VM stop gate.

The [R-03 private base-plan adapter](docs/R-03-PRIVATE-BASE-PLAN.md) reads a restored profile's ATS context and cached HH queries from explicit private directories, verifies the legacy generated-query hash and vacancy scope, and reaches the shared cold-search handler in an offline composition test. No live profile or token is read by this PR.

The [R-03 profile-bound HH credential broker](docs/R-03-PRIVATE-HH-CREDENTIAL.md) reads legacy plaintext or AES-GCM v2 token files from an explicitly bound private profile and performs one locked, encrypted OAuth refresh through the shared HH transport. Its integration test uses invented tokens and mock HTTP only.

An offline [R-03 background scoring pass](docs/R-03-BACKGROUND-SCORING.md) writes revision-bound ATS assessments to the private real-HH SQLite candidate state through an injected evaluator. It is designed for a five-minute timer but is not installed or connected to live LLM, HH, or the public page.

The offline [R-03 morning scoring bridge](docs/R-03-MORNING-SCORING-INTEGRATION.md) overlays accepted scheduled HH assessments in `morningResults`, preserves stale status for a newer unknown run, and holds uncertain snapshots out of background scoring until reconciliation.

The offline [R-03 accumulated real-HH feed](docs/R-03-ACCUMULATED-REAL-FEED.md) combines accepted scheduled and completed manual snapshots per profile/vacancy, retains older candidates, overlays revisioned ATS scores and private vacancy review/comment state, and quarantines unbound legacy candidates.

An [opt-in real proactive page/API foundation](docs/R-03-REAL-PROACTIVE-HTTP-FOUNDATION.md) reads that feed on `/hh/proactive` and `/api/hh/proactive/candidates` behind injected trusted profile and vacancy ownership ports. Default routes remain synthetic, and no production bind or MCP transport is enabled.

The [offline real proactive action adapter](docs/R-03-REAL-PROACTIVE-ACTIONS.md) adds durable schedule/manual and vacancy review/comment HTTP operations in opt-in mode, plus a test-only schema-validated MCP read fixture. Unsupported legacy actions remain unavailable.

The [offline review-aware search plan](docs/R-03-REVIEW-AWARE-SEARCH.md) connects vacancy comments and exclusion flags to durable query revisioning, injected regeneration and result filtering. It requires explicit trusted plan and query-generator ports before any real search is activated.
The [R-03 legacy schedule activation port](docs/R-03-LEGACY-SCHEDULE-ACTIVATION.md) requires explicit operator disposition of unknown legacy outcomes and migration readiness before releasing an imported schedule. It advances to a future Moscow slot, persists an audit receipt, and supports audited rollback. It is offline only; no imported schedule is live.

The [private HH search stack](docs/R-03-PRIVATE-HH-SEARCH-STACK.md) composes imported schedule activation, private profile plan, credential refresh, paginated HH transport, atomic candidate snapshot and morning read in an invented offline fixture. It has no production binding or installed timer.

The [HH query generator](docs/R-03-HH-QUERY-GENERATOR.md) provides a bounded service-ladder chat port and vacancy-derived fallback for review-aware query refresh. Its chat client is injected. [Base query regeneration](docs/R-03-BASE-QUERY-REGENERATION.md) now reuses the same generator for missing/stale private source caches and stores the result in target SQLite, without changing frozen legacy files.

The [service-ladder query client](docs/R-03-SERVICE-LADDER-CHAT.md) now supplies the exact HTTP request boundary through injected private token and fetch ports. The composed morning fixture exercises it with invented responses only.

The [free-ladder ATS evaluator](docs/R-03-FREE-LADDER-ASSESSMENT.md) now scores the accepted morning snapshot through an injected private HTTP/token boundary; the offline composition verifies the first 10 assessments appear on the morning page.

The [accepted ATS worker](docs/R-03-ACCEPTED-ATS-WORKER.md) uses the five-minute private score mode to drain all accepted scheduled and manual snapshots under a durable six-dispatch host budget. It prioritizes fresh, high pre-score candidates while reserving old-backlog progress, and holds uncertain provider outcomes for review.

The [occurrence heartbeat](docs/R-03-OCCURRENCE-HEARTBEAT.md) extends a long HH search's SQLite lease while it runs; a lost lease quarantines even a committed snapshot instead of showing false freshness.

The [private host minute tick](docs/R-03-PRIVATE-MINUTE-TICK.md) also renews the singleton timer lease across a long run and skips overlapping processes. It awaits an installed host timer and private configuration.

The [private host binding](docs/R-03-PRIVATE-HOST-CONFIG.md) now loads exact profile/vacancy and directory ownership from an owner-only JSON file and reads named host secrets through no-follow private file descriptors. No real mapping or secret is committed.

The [private host CLI](docs/R-03-PRIVATE-HOST-CLI.md) now has explicit check, minute and five-minute scoring modes. Live modes require private secret files and an opt-in execution flag; no timer is installed by this PR.

Disabled [systemd unit and timer templates](docs/R-03-SYSTEMD-TIMERS.md) now define the minute and five-minute clocks for a prepared private host. They were syntax-checked on the candidate RU host; installation and activation remain separate cutover steps.

The [private legacy content importer](docs/R-03-LEGACY-CONTENT-IMPORT.md) atomically stages all-candidates, seen IDs, snapshots and comments with exact profile/vacancy binding, replay checks and wildcard quarantine. It does not create accepted search receipts or surface imported content on the live page.

The [R-03 release workflow](docs/R-03-RELEASE-CD.md) builds a commit-pinned, checksummed source artifact after tests and provides a receipt-backed RU promotion/rollback command for the disabled staging unit. It does not activate the web service, HH timers or public routing.

The [private proactive web runtime](docs/R-03-PRIVATE-WEB-RUNTIME.md) now composes the private HH/SQLite stack with real page and action routes behind the old signed page-link HMAC, a short profile session and exact vacancy ownership. It is loopback-only and opt-in; legacy API and UI gaps still block nginx cutover.

The [morning page controls](docs/R-03-PRIVATE-WEB-CONTROLS.md) add schedule, manual search/polling and candidate review actions to the private page with browser-session authentication and revision checks. Remaining legacy features and live canaries still block cutover.

The [private web service unit and nginx cutover snippet](docs/R-03-PRIVATE-WEB-SERVICE.md) are uninstalled templates for the loopback runtime. RU systemd 249 and temporary nginx syntax checks passed read-only; no web service or route is running on the target.

The [private query editor](docs/R-03-PRIVATE-PROMPT-EDITOR.md) stores manual HH search queries and reset tombstones with target-side revisions in SQLite. Both scheduled and manual searches read the same override; the frozen source files remain untouched.

The [private seen-ID import](docs/R-03-PRIVATE-SEEN-IMPORT.md) marks exact HH resume IDs as already viewed for one trusted profile/vacancy in the target SQLite ledger, so the next search does not count them as new. It creates no candidate or snapshot and never falls back to an unspecified vacancy.

The [private archive import CLI](docs/R-03-PRIVATE-LEGACY-IMPORT-CLI.md) derives a private source inventory, verifies an immutable backup and exact operator mappings, runs a no-target-write preflight, then requires `--execute` to stage content and a private receipt. It is not run by the public service or CI against real files.

The [controlled legacy seen promotion](docs/R-03-LEGACY-SEEN-PROMOTION.md) plans eligible rows from the final private import, excluding historical-only and anomalous references, then requires an exact selection hash and explicit execution to seed `real_hh_seen` transactionally. It never accepts an old snapshot or replays an unknown cron run.

The R-04 lifecycle foundation creates a profile-scoped synthetic draft from a candidate/vacancy source revision, allows edits only to client-audience fields, renders through the same escaped renderer, records explicit review state, and supports publication/revoke only through an injected server-side adapter. The identity resolver and publication adapter both default to deny. Publish/revoke requests carry stable operation IDs; concurrent duplicates are coalesced in-process. An adapter exception returns a stored unknown outcome and leaves local state unchanged, but the external effect may already have happened. Repeating the operation does not call the adapter again; the report remains blocked from further lifecycle mutations because there is no reconciliation endpoint. Any live adapter must deduplicate by operation ID and reconcile uncertain outcomes before retry; this prototype does not provide production retry safety. Edits and review transitions are rejected while publication/revoke is in flight. A successful fixture publish returns a stable report reference and synthetic receipt, not a public URL. Routes remain absent from C14 discovery. Approved client fields, consent, real access policy, publication owner, canonical source freshness, persistence/audit and production authorization remain open. See [`docs/R-04-DRAFT-LIFECYCLE-FOUNDATION.md`](docs/R-04-DRAFT-LIFECYCLE-FOUNDATION.md).

These are **R-01 and R-04 foundations**, not completion of the production scenarios. Actual identity-to-profile mapping, tenant semantics, response meaning/fields, trusted scope grants, freshness against a live canonical store, report owner, client-field approval, and report-source revision semantics remain open under issue #3. See [`docs/R-04-REPORT-FOUNDATION.md`](docs/R-04-REPORT-FOUNDATION.md) for inspected legacy behavior and deliberate differences.

The existing `trained-assist-hh-skill` is coupled to in-process execution and profile files and remains the source for differential behavior checks. This repository has SQLite state and uninstalled RU deployment templates, but no production credentials or candidate data. The public route, live provider integration and agent-owned profile/MCP binding still require acceptance before use.

For the full Agent Runner to public-site transport probe, set `AI_AGENT_RUNNER_ROOT` to an isolated built Agent Runner checkout and `RECRUITING_SANDBOX_PUBLIC_ORIGIN` to the stable synthetic Workers.dev origin, then run `npm run test:sandbox-agent-cold-search`. The probe uses a synthetic login/profile and vacancy, invokes the schedule and occurrence capabilities through Agent Runner's real MCP bridge, enables a 24-hour schedule, triggers one synthetic scheduled tick, confirms fresh candidates and occurrence state through the site, checks cross-profile denial, and verifies the session cookie is absent from persisted run artifacts. It does not call HH.

`npm run test:sandbox:agent-mcp` exercises the local HTTP path through Agent Runner's stdio MCP bridge with synthetic dependencies. It inspects the short-lived MCP configuration during invocation, verifies restrictive file permissions and absence of the resolved binding secret, reads MCP evidence from Runner logs, and checks the temporary workspace is removed. It does not connect to the public Worker or production relay.
