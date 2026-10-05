# trained-assist-recruiting-web

Independent recruiting application and versioned platform contracts.

## Initial service and R-01 foundation

This repository owns the recruiting domain boundary. The platform/agent can consume the versioned HTTP contract without importing recruiting implementation code. This prototype serves **synthetic vacancy and report fixtures only** and performs no domain writes.

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

JSON Schemas live in `contracts/`. The C14 manifest advertises only the unscoped synthetic vacancy list; profile and report preview routes are intentionally absent from its capability registry and endpoint map until trusted out-of-band context exists. The manifest otherwise follows the proposed C14 connected application contract: stable `serviceId`, release/source revision/environment, bounded platform contract range, domain API version, typed capabilities, compatibility declarations, and typed readiness with a checked version tuple. The current readiness reason explicitly limits this fixture service to local synthetic use. CI validates manifest, vacancy, local profile-slice, internal report source, and client preview responses against the checked in JSON Schemas (`ajv`) and exercises HTTP behavior with Node's built in test runner (`npm test`). Domain mutations are not implemented; unsupported methods return `405`.

The browser demo demonstrates selecting a fixture vacancy and reading synthetic response summaries. Its local-only routes send `X-Demo-Profile-Id`; the service checks the fixture profile match, declared fixture scope, and vacancy assignment. The header and scope map are spoofable test scaffolding, **not authentication**, and the routes are not an agent capability. There is no trustworthy user identity, tenant boundary, credential broker, session handling, or production scope grant here. A future adapter must supply trusted profile context out of band before these routes can enter the C14 capability registry or serve real profile data. Response pages return a stable `revision` and `freshness: current`; cursors pin profile, vacancy, revision, and offset. A cursor from a different revision returns `409` with `freshness: stale` and the current revision so the UI can restart. Fixtures contain only fake IDs, status, and timestamps; no candidate names, contact details, or free text.

This is an **R-01 foundation**, not completion of the production scenario. Actual identity-to-profile mapping, tenant semantics, response meaning/fields, trusted scope grants, and freshness guarantees from a live canonical store remain open under issue #3.

The client report preview uses a hand-written synthetic source fixture. Its internal source and client view have separate schemas; the client view is an explicit field allowlist. The preview HTML is deterministic, escapes all fixture text, carries the synthetic source revision, and is visibly marked as a draft not for sending. The route is a local UI GET and is not listed in C14 capabilities or manifest endpoints. There is no write, publish, download, or sharing route.

These are **R-01 and R-04 foundations**, not completion of the production scenarios. Actual identity-to-profile mapping, tenant semantics, response meaning/fields, trusted scope grants, freshness against a live canonical store, report owner, client-field approval, and report-source revision semantics remain open under issue #3. See [`docs/R-04-REPORT-FOUNDATION.md`](docs/R-04-REPORT-FOUNDATION.md) for inspected legacy behavior and deliberate differences.

The existing `trained-assist-hh-skill` is coupled to in-process execution and profile files. It is a source of requirements to inspect during a later migration, not code to copy blindly into this service. This repository has no production integration, credentials, real candidate data, database, or deployment configuration. The schema and endpoint names are initial proposals and need review before a real integration or persistence layer is added.
