# R-01/R-04 trusted read session boundary

`createRecruitingReadSessionResolver` is an opt-in HTTP authentication adapter for the existing `createRecruitingServer` read routes. It accepts only a bearer credential verified by an injected agent/platform `verifyToken` port. That port must validate the issuer cryptographically or by live introspection; decoding a token or trusting proxy headers is insufficient. The resolver then requires the configured issuer and `recruiting-web` audience, live `nbf`/`exp` with at most one hour of validity, a stable user, profile and session ID, and a current `isProfileBound(user, profile, session)` decision. It emits only profile ID and scopes. A revocation or profile switch can therefore invalidate the binding on the next read.

The R-01 HTTP route requires `recruiting.responses.read`; the R-04 source route requires `recruiting.reports.read`. The R-03 signed-link cookie carries only `recruiting.candidateSearch` and is never consumed by this adapter. The source read remains a proposal, not an approved or published report. This module is not mounted in the private R-03 process or production manifest.

## Agent-owned context contract and runtime gap

The Agent-owned Profile Context v1 contract is pinned at Agent revision `4a60c2e4c45eca9de1b84bba55e38bb83e1478c8`, and the CP identity contract pins the same revision. It defines authenticated principal, current profile, Agent session and monotonic profile generation; the Recruiting consumer pins both contracts and their schemas. The Agent artifact is explicitly `contract_only`, and the CP production resolver remains `not_wired`.

The retiring Agent web JWT cookie and browser-readable `web_current` selector do not prove a human principal, Agent-owned membership or a current profile generation. They cannot implement this contract. The remaining integration needs an existing trusted Agent user/session and membership source, an Agent-side resolver wired to it, current-session revalidation in CP, and explicit host-side membership provisioning. Do not create a new login provider or adapt the legacy cookies. Browser handoff still needs a short-lived code exchange so app tokens never appear in URLs or third-party scripts. Only after real identity mapping and revocation are available should the host mount R-01/R-04 routes and test a real HH read and report-source canary.

Offline tests use invented claims and a fake verifier. They prove the local validation and route scope separation, not issuer cryptography, real session revocation, browser handoff or live HH access.

The consumer pins control plane identity v1 at the revision and SHA-256 digests in `contracts/connected-app-identity-v1.source.json`. CI checks its copied contract and response schema plus the Recruiting audience/scope vocabulary. Updating the producer requires an explicit pin update and consumer review. The CRM audience is reserved by the producer; CRM needs its own consumer parity check before use.
