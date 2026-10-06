# Full HH discovery budget and separate ATS backlog

The user-facing morning result has two independent facts:

1. `freshness=latest_completed` means **all current search queries and all
   provider pages** were read and one atomic candidate/seen/snapshot write was
   accepted by its durable occurrence. A failed later page, stale plan,
   exceeded request/item cap or lost lease cannot publish a partial snapshot.
2. `assessmentStatus=assessment_pending` means candidates in that accepted
   result still lack an ATS assessment. The page shows the count; the API and
   MCP-facing domain read return `assessmentStatus`,
   `assessmentPendingCount` and `assessmentBlockedCount`. The accepted-snapshot
   assessment queue includes older accepted snapshots in the accumulated feed,
   uses a durable SQLite claim/lease cursor, and evaluates at most ten
   candidates per tick. It does not alter the discovery snapshot or its
   freshness. Expired leases become `outcome_unknown`; stale criteria and
   repeated evaluator failure become explicit `assessment_attention`, not an
   endlessly pending count. Reconciliation of unknown assessment attempts is
   an operator step before retry.

The full discovery caps are 15 saved queries, 40 pages per query, 80 HH GETs
per occurrence, 3,000 raw items before deduplication, `per_page=50`, and one
attempt per page. Page-zero probes use `per_page=1`, one attempt and at most
one GET per saved query. They write an owner-only receipt with query hashes,
current criteria/query revisions, estimated requests and raw item upper
bound. A blocked or older-than-15-minute receipt fails before dispatch. Actual
search independently enforces every cap because HH counts can change between
probe and run. A budget reached after provider dispatch is a typed unknown
occurrence with no accepted freshness; it needs reconciliation, never blind
replay. No full real search, timer, route switch or imported schedule release
is performed by this module.

Current RU read-only observation for one owned scope: seven queries, seven
page-zero requests, summed `found=2619`, estimated 56 pages at 50 per page,
largest query 1,044 matches. This is an estimate before overlap/deduplication;
it does not establish a safe ATS call count. The separate ten-per-tick ATS
budget avoids treating a potentially large LLM backlog as a prerequisite for
seeing newly discovered candidates. The earlier partial scheduled rehearsal
remains quarantined and cannot satisfy this full discovery gate.

Before any real full execution, bind the preflight to the exact review-aware
query plan (including feedback/query overrides) and verify that the host uses
the same revision. Run a controlled full canary on a disposable DB only after
reviewing the current HH request estimate and available rate/cost budget. A
natural scheduled cycle, page/API, service deployment, profile authorization,
old unknown investigation and GCP independence remain separate acceptance
gates.
