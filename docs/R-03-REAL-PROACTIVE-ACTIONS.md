# R-03 opt-in real proactive actions and offline MCP read

This slice adds real-mode adapters on the existing `/api/hh/proactive/*` namespace. They use the same trusted profile resolver as the read route and check exact vacancy ownership in the injected domain ports. The default synthetic mode is unchanged. No real mode is enabled by the command-line server or bound to a public host.

| Route | Real-mode behavior |
|---|---|
| `GET /api/hh/proactive/candidates` | Accepted accumulated feed from #31. |
| `GET /api/hh/proactive/schedule`, `GET /api/hh/proactive/occurrences` | Profile/vacancy-scoped SQLite schedule and occurrence reads. |
| `POST /api/hh/proactive/vacancy-state` | `enable` or `disable` durable schedule; enabling requires a trusted current search plan and blocks on an unknown occurrence. Existing imported schedule IDs are preserved. |
| `POST /api/hh/proactive/search` | Start a durable manual run using a required `Idempotency-Key`; returns `202` and a run to poll. No synchronous HH request in the HTTP handler. |
| `GET /api/hh/proactive/manual-runs/{runId}` | Profile-scoped durable status polling. |
| `POST /api/hh/proactive/set-status`, `POST /api/hh/proactive/comment` | Vacancy-scoped candidate overlay with required `expected_revision`; a stale edit returns `409`. |

The route inventory was checked against the current legacy `hh-routes.js`. `/api/hh/proactive/prompt`, `/ai-score`, `/add-manual` and `/import-seen` are **not yet implemented** in real mode and return `501`. Legacy page flags `star`, `unstar`, `archive` and `restore` on `/vacancy-state` also remain unsupported. The old page's POST shapes used `username`/`token` and synchronous search; the new real mode uses server-side trusted identity, explicit vacancy and durable async polling. The server-rendered real page currently shows candidates but has no action controls. Existing public links keep their paths, but client-side action parity and query/cache feedback need a separate slice before route cutover.

The offline descriptor `contracts/r03-real-results.offline-capability.json` names `candidateSearch.getResults`, points to versioned input/output JSON Schemas, and is exercised through a test-only MCP JSON-RPC fixture. Its handler is `createRealProactiveRead`, the same operation used by the HTTP page/API; the caller's profile never appears in tool arguments. The fixture blocks network egress. The descriptor is **not** in the production C14 capability registry or manifest until a trusted relay transport and authorization are accepted. This follows the semi-static offline compliance rule from architecture PR #157 without publishing an unbound tool.

Tests use invented candidates and local private SQLite. They exercise enable/status/occurrences, durable manual start/poll, review and comment revisions, unknown manual snapshot quarantine, HTTP auth, MCP discovery/call and schema validation. Production still needs a canonical profile/vacancy resolver, persisted search plan/query owner, HH/LLM and five-minute worker, UI action controls, legacy import and RU host acceptance under HH #187.
