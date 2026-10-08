# R-03 HH resume transport boundary

`src/hh-resume-transport.js` isolates the first real provider request without connecting it to the synthetic job handlers. Construction requires three injected ports: `loadVacancyContext(profileId, vacancyId)`, `loadCredential(profileId)`, and `fetchImpl`. The first two must return records explicitly bound to the requested trusted profile and vacancy. `refreshCredential(profileId, previousAccessToken)` is optional and, when present, must return a similarly bound replacement credential. This module does not read profile files, environment secrets, or ambient `fetch`; creating it without an explicit fetch adapter fails.

`search({ trustedContext, vacancyId, query, area? })` requires the `recruiting.candidateSearch` scope. Geography precedence follows the legacy transport: an explicit request area, then ATS `filters.area`, ATS `area`, then vacancy `area`. Missing or non-numeric geography fails closed. An explicit `null` or empty array means unrestricted. The request uses `GET https://api.hh.ru/resumes`, `per_page=50`, and `order_by=relevance`, starting at page 0 and reading every reported page up to 40. A larger window or a changing page count fails the whole search instead of silently publishing a partial morning feed. HTTP 429/5xx and transient transport failures get at most two bounded retries per page; 401/403 can refresh once per search. Errors expose stable codes without response bodies, candidate data, queries, or tokens in logs.

Source mapping inspected from `trained-assist-hh-skill` at `af25f267bd20498c02f578b7b77ffc587dad3e85`:

Rechecked against `origin/main` `60566b5` on 2026-10-06: the context and
transport source files are unchanged. The current legacy routes/search code
also has asynchronous manual search polling and phase/ATS-refresh progress;
those lifecycle endpoints are outside this transport boundary and remain
required for public-route parity.

| Legacy owner | This slice |
|---|---|
| `src/hh-cold-search-context.js:27-41` resolves profile/vacancy ATS config, including legacy files | Trusted `loadVacancyContext` port; no legacy file reader or importer yet |
| `src/hh-proactive-search.js:910-928` reads a profile token and checks area context | Bound `loadCredential` port and explicit area resolution |
| `src/hh-cold-search-transport.js:3-53` builds the first HH page and retries | Injected, mockable fetch transport with fixed endpoint, bounded errors and multi-page collection |
| `src/hh-proactive-search.js:934-1110` handles cached queries, ranking, seen IDs, candidates, snapshots | Outside this slice; existing synthetic job validators and state remain unchanged |

The returned `items` are raw HH provider records for a later mapping/scoring adapter. They must not be passed into the current synthetic candidate job contract, whose fixture-only ID and revision validators deliberately reject real HH records. Production work still needs profile migration and credential ownership, query generation/cache, HH response mapping, scoring, durable write ordering, background rescoring, trusted web sessions, and the non-GCP worker/route cutover. The tests use only injected fake credentials and mock fetch; no live HH call, token copy, deploy, or schedule activation occurred.
