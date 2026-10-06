# R-01 exact assignment send foundation

This module is the domain/transport foundation for issue #90. It is not mounted
on the public/private HTTP server and it does not create or consume Control
Plane approval intents. A caller must pass a server-validated CP receipt; the
browser must never be allowed to manufacture that receipt.

Before dispatch, the sender checks the exact current saved source and plan
digests, binds the CP receipt to the exact canonical operation and its request
hash, requires an explicit recruiter confirmation of the selected candidate
agreement message, reads fresh exact-chat history, and blocks stale agreement
or duplicate outbound text. The durable SQLite outbox stores the exact
operation, CP receipt, CP request hash and one HH UUID idempotency key before it
claims dispatch. The state transition to `dispatching` is an atomic one-use
fence. The process makes at most one HH POST for that operation.

After a successful or ambiguous provider result, it refreshes the exact
conversation. An exact employer message after dispatch becomes `verified`;
otherwise the operation stays `unknown` and later calls perform history reads
only. A process restart with a `dispatching` row cannot issue a second POST.
`verified` means the exact outbound text appeared in HH chat history; it does
not prove candidate delivery, receipt, or response.

The HH adapter uses `POST /common/chats/{chat_id}/messages` with a persisted
UUID `idempotency_key` and the exact saved `text`. The official [HH OpenAPI
contract](https://api.hh.ru/openapi/en/redoc) defines UUID keys and a 409
response for a non-unique key. This client still never retries a POST: network
errors and key conflicts are reconciled through a fresh chat read.

## Not yet delivered

- The private BFF now has server-only CP prepare/consume client calls and an
  encrypted, session/profile-bound approval handle with stable consume recovery.
  The returned approval URL is restricted to the configured CP issuer.
- These methods are not yet wired to assignment HTTP handlers or a browser
  prepare → review → resume flow. The send scope is vocabulary and an opt-in
  re-auth request only; no profile membership or production grant is added.
- There is no browser/server route or agreement-confirmation UI.
- Proposal creation is not implemented as an independently approved HH write.
- The UI for selecting and explicitly confirming the applicant agreement
  message is not implemented; the function requires that confirmation as a
  caller-supplied boolean, so it must not be exposed directly to a client.
- Delivery/read/reply lifecycle after verified send is still pending.
- No live HH credentials or candidate data are used by CI. The recovered
  Wildberries task remains private and is not imported or sent.
