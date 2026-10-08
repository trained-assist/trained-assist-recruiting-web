# One-page manual HH rehearsal

`r03-private-manual-rehearsal.js` accepts only the disposable SQLite copy made
by the private schedule stage. It verifies that all 11 imported schedules are
disabled and blocked, eight carry the old unknown quarantine, and there are
zero occurrences. The imported migration DB remains outside the mutation
path.

For one explicitly owned vacancy with a current ATS and saved query, the
command derives a rehearsal-only query revision and allows exactly one query,
one HH request, page zero, `per_page=1`, and one attempt. It does not refresh
the HH token or generate queries. A provider window wider than one page is
read only through its first page. The existing manual search handler writes
its run and snapshot receipts to the disposable DB only; its owner-only
receipt records the request budget, response page count and aggregate result
counts. An error after dispatch leaves an `outcome_unknown` rehearsal row and
never automatically retries. An exact repeated invocation verifies the
private file receipt against the durable manual run and snapshot and returns
`replayed` with zero provider requests. If the run exists but the file receipt
is missing, it fails closed without redispatch and requires investigation.

This intentionally partial rehearsal snapshot must never be copied into the
migration DB or treated as morning freshness. The purpose is to test the
real HH transport, resume mapping, atomic candidate/seen/snapshot write and
manual receipt path with a strict cost bound. No timer, public route, or old
unknown occurrence is activated.
