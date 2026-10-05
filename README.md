# trained-assist-recruiting-web

Independent recruiting application and versioned platform contracts.

## First slice

This repository owns the recruiting domain boundary. The platform/agent can consume the versioned HTTP contract without importing recruiting implementation code. This prototype serves **synthetic vacancy fixtures only** and is read-only.

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
| GET | `/api/v1/profiles/{profileId}/vacancies` | Vacancies assigned to one synthetic profile |
| GET | `/api/v1/profiles/{profileId}/vacancies/{vacancyId}/responses` | Anonymous synthetic response summaries for that profile's vacancy |

JSON Schemas live in `contracts/`. The manifest follows the proposed C14 connected application contract: stable `serviceId`, release/source revision/environment, bounded platform contract range, domain API version, typed capabilities (required flag, input/output schema references, effect, scopes and operation), compatibility declarations, and typed readiness with a checked version tuple. The current readiness reason explicitly limits this fixture service to local synthetic use. CI validates manifest, vacancy and profile-slice responses against the checked in JSON Schemas (`ajv`) and exercises HTTP behavior with Node's built in test runner (`npm test`). Unsupported methods return `405`; there are no write routes.

The browser demo demonstrates selecting a fixture vacancy and reading its synthetic response summaries. It sends `X-Demo-Profile-Id`; the service checks that it matches the requested profile and then checks the synthetic profile's declared fixture scopes and vacancy assignment. This header and fixture scope map are **test scaffolding only**, not authentication or authorization suitable for a real user. There is no trustworthy user identity, tenant boundary, credential broker, session handling, or production scope grant in this repository. A production binding must supply a platform-authenticated principal and an approved profile/scope mapping before any real profile data is connected. Response fixtures contain only fake IDs, status, and timestamps; they have no candidate names, contact details, or free text.

The existing `trained-assist-hh-skill` is coupled to in-process execution and profile files. It is a source of requirements to inspect during a later migration, not code to copy blindly into this service. This first slice has no production integration, credentials, candidate records, database, or deployment configuration. The schema and endpoint names are an initial contract proposal and need review before a real integration or persistence layer is added.
