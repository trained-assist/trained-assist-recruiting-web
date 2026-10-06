# R-03 private profile search-plan adapter

`createPrivateBaseSearchPlan` reads a profile's restored ATS context and vacancy query cache from explicit owner-only directories supplied by a trusted profile binding port. It checks the requested profile/vacancy, scoped ATS ID, explicit HH area and the legacy generated-query cache hash (including old recruiter comment text). A manually pinned query list remains pinned. It reads files through no-follow descriptors and returns a versioned criteria/query revision to the shared search runner; it never reads a token or chooses a profile from request data.

The offline test composes this adapter with the review-aware query layer, mock HH transport, and the real private SQLite candidate state. A synthetic scheduled search commits one candidate and seen ID through those shared handlers. Wrong ownership, a changed ATS source, missing area, stale generated cache and symlinked files fail before dispatch.

This adapter is one production-shaped input boundary, not a running service. It requires a private profile mapping and restored directories, an authorized HH credential/refresh broker, query generation when a cache is absent or stale, a live evaluator and target worker/timer. No real profile files, credentials or HH requests were used. The application must not fall back to a different profile, project or region when a file is missing.
