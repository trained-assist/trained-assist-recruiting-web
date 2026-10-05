# R-04 synthetic draft lifecycle foundation

This is a synthetic workflow foundation, not complete R-04. It extends the renderer proof in PR #6 with a shared in-memory service for draft creation, client-field edits, preview, review, publication receipt and revoke. Lifecycle routes require the injected trusted profile/scope resolver; its default denies. The routes are local UI fixtures and remain absent from C14 manifest/capability discovery.

Draft creation requires candidate ID, paired vacancy ID, expected synthetic source revision and an idempotency key. The report reference is stable for the profile/key pair. Every edit and review transition is revision-bound. Candidate identity and vacancy title remain source-projected; edits are limited to summary, experience, fit and conclusion. The renderer used by lifecycle preview is the same escaped renderer as the original R-04 preview foundation. Internal evaluation, risk, evidence and correspondence fields are never projected into client output.

Publication requires an explicit `approved` review state and calls only the server-injected publication adapter with the client projection and source/review revisions. The default adapter denies. Adapter rejection or exception leaves the approved draft unchanged. On adapter approval, the service returns the stable synthetic `reportRef` and a receipt identifier; it does not return a public URL or expose a public read route. Revocation also requires the injected adapter and a current report revision; a revoked report preview returns `410`.

All report state and idempotency records are process-local and synthetic. This does not provide durable audit, multi-instance consistency, client access controls, or real publication.

## Unknown before production use

- Which client fields are approved, and whether candidate consent is required for each field/audience.
- Who can review, publish, revoke, and access a report; how their identity, organization, and client audience are verified.
- Publication access policy (expiry/password/recipient), delivery channel, and whether published artifacts have stable external URLs.
- Canonical candidate/vacancy/report owner, actual source revision guarantees, and stale-source handling when source data changes.
- Draft persistence, history/audit retention, concurrent edits, retries/idempotency across restarts, and adapter transaction/reconciliation semantics.
- Whether candidate name, conclusion, and fit fields are safe and accurate enough for client use.

No production candidate PII, credentials, external provider, storage, LLM, share link, or publication service is connected. The existing unscoped report preview endpoint remains limited to a fixed synthetic fixture; the new lifecycle endpoints are profile-scoped and deny by default.
