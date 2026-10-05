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
| GET | `/api/v1/readiness` | Versioned readiness |
| GET | `/api/v1/manifest` | Service manifest and endpoint map |
| GET | `/api/v1/capabilities` | Declared capability list |
| GET | `/api/v1/vacancies` | Synthetic vacancy fixture list |

JSON Schemas live in `contracts/`. CI runs contract-oriented and HTTP behavior checks with Node's built-in test runner (`npm test`). Unsupported methods return `405`; there are no write routes.

The existing `trained-assist-hh-skill` is coupled to in-process execution and profile files. It is a source of requirements to inspect during a later migration, not code to copy blindly into this service. This first slice has no production integration, credentials, candidate records, database, or deployment configuration. The schema and endpoint names are an initial contract proposal and need review before a real integration or persistence layer is added.
