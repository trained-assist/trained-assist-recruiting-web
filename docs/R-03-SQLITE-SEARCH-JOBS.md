# R-03 durable candidate-search jobs and result pages

`SqliteCandidateSearchJobs` is an optional implementation of the existing
candidate-search job API. It can be injected into `createRecruitingServer` as
`candidateSearchJobStore`; the default remains the in-memory synthetic store.
It uses `better-sqlite3` on a single host, requires an owner-only `0700`
database directory, and can share the same SQLite file as the schedule store.

## Dispatch boundary

The `(profileId, idempotencyKey)` pair is unique in SQLite and is bound to a
hash of the canonical request. A new job, or a resumed page, first commits a
`dispatching` row with an owner and deadline. Only then does it call the
provider. A valid page is appended with its source revision and next cursor in
one transaction. The final page also stores `completedAt`; materializing
candidate state after a restart uses that original completion time for
freshness. Result cursors are tied to the committed result revision.
Two web/worker processes using the same file cannot dispatch the same page
from the same job concurrently.

If a process crashes or a call exceeds its deadline, the stored dispatch
becomes `outcome_unknown` when read or retried. A thrown provider call,
malformed response, changed source revision, or failed result validation is
also treated as unknown. The job cannot resume and an idempotent retry returns
that state without another provider call. This is conservative: the provider
may have executed even if the response never reached SQLite. A response from
an expired dispatch cannot overwrite quarantine. The `operationId` passed to
the provider is stable for a job page, but the synthetic provider ignores it;
real HH/provider idempotency and reconciliation remain unproven.

The public job schema now includes `outcome_unknown` and
`search_outcome_unknown`. It is never a completed or fresh candidate result.
Already committed partial pages remain readable, but must not be presented as
the morning's completed search. The stored rows currently use synthetic IDs,
criteria and candidates; a production data model needs privacy, retention,
backup, migration, and real provider validation before use.

`node --test test/sqlite-candidate-search-jobs.test.js` checks restart between
pages, profile-scoped idempotency, committed result cursors, changed source
revision, two open connections observing an in-flight dispatch, lease expiry,
late provider response fencing, and the HTTP read path after restart. This
slice does not install a timer, connect HH, reconcile unknown outcomes, or
move the candidate/seen store and background scorer. It does not satisfy the
GCP VM stop gate in [HH #187](https://github.com/trained-assist/trained-assist-hh-skill/issues/187).
