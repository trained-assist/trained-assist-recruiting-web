# Bounded scheduled HH rehearsal

`src/r03-private-scheduled-rehearsal.js` is an operator-only, explicit
`--execute` command. It verifies the owner-only migration DB, the staged
schedule receipt, all 11 disabled imported jobs and all eight unknown-outcome
quarantines. It backs up the staged disposable DB into a **new** private
directory, then inserts one invented due schedule for an owned vacancy. The
source migration DB and original stage DB are opened read-only and their file
hashes are checked after the run. No old schedule is activated or replayed.

The real minute lease, occurrence claim, HH transport, resume mapper,
candidate/seen/snapshot transaction and accepted-snapshot assessment ports
run with a strict `1 query × 1 page × per_page=1 × 1 attempt` HH budget and
at most one free-ladder assessment. The invented schedule is disabled and
blocked after the tick. A terminal provider error is `outcome_unknown`; a
crash without a file receipt fails closed on the next invocation. Exact
receipt replay reads SQLite and makes zero provider requests.

The result is **`partial_rehearsal`**. A successful occurrence here is *not*
an accepted morning result: the receipt says `acceptedForMorning=false`,
`freshness=not_accepted_partial`, `fullQuerySet=false` and
`fullPagination=false`. Never point a web runtime at this disposable DB or
copy its snapshot into the migration DB. The worker's internal
`latest_completed` projection in this test database is only evidence that
the isolated occurrence wiring works.

Next acceptance step: run the full current query set and all HH pages with a
predeclared request, candidate and assessment budget. If the window exceeds
that budget, retain it as partial/unknown and do not publish freshness. Then
check the whole scheduled cycle, retries, no overlap, profile scoping and
morning page/API on RU with the old GCP VM off. A real production schedule is
released only after the eight old unknown outcomes are resolved per job.
