# R-04 scoped report instructions

The private accepted-report flow now has a versioned instruction store with four scopes in this precedence order:

1. `profile` — derived from the authenticated Connected App profile; callers cannot supply the profile ID.
2. `vacancy` — the currently verified profile-owned vacancy.
3. `candidate` — the accepted candidate within that vacancy and profile.
4. `report_version` — one exact report revision, after the server confirms that the draft belongs to the same profile, vacancy, candidate, source kind, and current source revision. Requests include both `reportRef` and `reportRevision`; a superseded revision is rejected rather than presented as current.

Each scope holds `includeGuidance`, `styleGuidance`, and `recruiterNotes` (up to 30 items per list, 1000 characters per item, and 8000 characters total). The API returns both ordered effective lists and the scope/revision provenance for every entry. Every revision is encrypted in the report SQLite store and retained in a bounded 100-entry history, which the page displays for the selected scope. Updates use optimistic revision checks. The route reads only the accepted report source; it does not read HH messages, send a message, publish a report, or change an assignment or schedule.

`GET /api/v1/ui/accepted-report-instructions` requires `recruiting.reports.read` and exact `candidateId`, `vacancyId`, optional `sourceKind`, and paired optional `reportRef` / `reportRevision` query parameters. `PUT` on that route requires `recruiting.reports.edit`, the normal Connected App CSRF token, and `expectedRevision` for the selected scope. Report-version updates require both report identifiers.

These notes are durable, profile-isolated recruiter guidance for report authoring. This slice exposes and preserves them; it does not yet call a model or claim that generated text follows the guidance. Forbidden phrase enforcement remains a separate candidate/vacancy-bound policy. Regeneration provenance and merge behavior are later work under #108.

Contracts: `contracts/v1-accepted-report-instructions.schema.json` and `contracts/v1-accepted-report-instructions-update.schema.json`. Real HTTP and SQLite coverage: `test/r04-accepted-report-drafts.test.js`.
