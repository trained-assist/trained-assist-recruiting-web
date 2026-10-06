# R-03 private seen-ID import

The morning page now accepts a bounded list of exact HH resume IDs or `https://hh.ru/resume/...` links. The browser sends `POST /api/hh/proactive/import-seen` with `vacancy_id` and normalized `ids` under its profile cookie. The server takes the target `profileId` only from trusted context, checks the explicit vacancy binding, validates every ID, and inserts the whole batch into the existing SQLite `real_hh_seen` ledger in one immediate transaction. Duplicate input and repeated requests add zero rows. A bad ID or transaction failure adds none. There is no legacy active-vacancy, latest-snapshot or `unknown` fallback.

Imported IDs affect the next search snapshot's `newCount`: a resume already marked seen is not counted as a new discovery. The command does not create a candidate, assessment, snapshot or accepted search receipt, and does not hide an accepted candidate from the accumulated feed. This matches the ledger's actual role in the old search code. The same SQLite transaction boundary serializes import against search snapshot commits.

Tests use invented IDs to cover duplicate and cross-profile/vacancy cases, invalid all-or-nothing input, injected rollback, the next snapshot's `newCount`, HTTP scope, and browser URL parsing. Legacy open tabs using JSON `username`/`token` remain incompatible; this PR does not switch nginx or use live HH data.
