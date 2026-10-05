# R-04 candidate report foundation

Status: synthetic local preview foundation; not complete R-04.

## Legacy behavior inspected

Read-only inspection of `trained-assist-hh-skill` at source SHA `af25f267bd20498c02f578b7b77ffc587dad3e85` (`main`; the checkout was 17 commits behind `origin/main` during review):

- `src/hh-candidate-report.js` has a first-generation client HTML template taking candidate, client/vacancy, summary, matrix, experience, conclusion, and video fields. It emits warnings for missing summary, matrix, conclusion, and video. Its report-note/data/HTML files are stored under each profile work directory.
- The same file defines `ReportDraft v2`, audience values `internal` and `client`, and report scopes `agency`, `vacancy`, `candidate`, and `report_version`.
- `src/hh-eval-docs-v2.js` defines `CLIENT_FIELDS` and an explicit client projection from the draft. Client HTML is rendered from that projection and HTML-escapes displayed values. Internal evaluation fields such as scores, evidence, expert checks, risk logs, contradictions, and internal notes are not intended for the client document.
- `tests/unit/hh-routes.test.js` covers internal evaluation and branded client profile HTML, including assertions that `expert_check`, `risk_log`, and `evaluation_id` do not appear in the client HTML. Nearby routes also support Markdown/PDF output and use the legacy profile token path.
- `mcp.manifest.json` exposes legacy report context, note editing, Markdown, and HTML capabilities. Those file-backed and agent-coupled workflows are not imported here.

The inspection was limited to source and tests. The checkout was behind upstream, so this is not a guarantee that it represents the latest legacy behavior. No legacy source or fixture records were copied into this repository.

## This repository's R-04 foundation

`data/report-scenarios.json` is hand-written synthetic data. It pairs one fake candidate and one fixture vacancy and includes visibly marked internal-only values plus a client-facing report draft. `v1-report-source-internal.schema.json` models the source; `v1-client-report-preview.schema.json` constrains the returned client view with `additionalProperties: false` and an explicit field list.

`GET /api/v1/ui/report-previews` renders that fixed fixture only. It is a local UI route, omitted from the C14 manifest/capability registry, and returns a preview envelope with `audience: client`, `previewOnly: true`, `publication: disabled`, and `sourceRevision`. The renderer projects allowed client fields, escapes dynamic HTML text, and is deterministic. It does not call an LLM, write files, save drafts, publish, download, or share.

## Differences and unresolved decisions

- The prototype uses a much smaller DTO: candidate name/position, vacancy title, summary, experience, fit, and recruiter conclusion. It does not implement the legacy profile's notes, regeneration/edited-field preservation, branding, contact/photo handling, videos, tests, appendices, Markdown, or PDF.
- The selected response/risk information is not copied into a report. No actual evaluation object or score is consumed.
- The `sourceRevision` is a synthetic fixture label, not a database revision or proof of freshness from a canonical source.
- The exact owner and canonical source of candidate reports are unverified. Candidate/vacancy pairing in this slice is a fixture mapping only.
- The intended client fields, consent/approval process, and meaning of “fit” and “recruiter conclusion” need domain-owner review before using real data.
- There is no trusted user/profile context on the preview route. It remains local and unadvertised; real candidate data must not be connected until that boundary and the source owner are agreed.

The original renderer/schema PR was not a client report workflow or publishable report. The follow-on [`R-04 draft lifecycle foundation`](R-04-DRAFT-LIFECYCLE-FOUNDATION.md) adds a synthetic profile-scoped lifecycle while preserving the same client-field projection and escaped renderer. It still is not production publishing or approval policy.
