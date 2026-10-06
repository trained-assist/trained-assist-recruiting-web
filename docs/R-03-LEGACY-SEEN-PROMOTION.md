# R-03 controlled legacy seen promotion

The final private content import stores old `seen-ids.json` rows as raw
evidence. Before the first live HH search, eligible rows can seed the target
`real_hh_seen` ledger so historical candidates are not counted as newly found.
This is a separate operation. It does not create a candidate projection,
accepted historical snapshot, `newCount`, search occurrence or schedule.

The planner requires the owner-only import config and its `final_frozen`
operation receipt. It verifies the archive SHA-256 and byte count named by
that receipt, each source digest and raw file receipt against the staged
SQLite import rows, and exact profile/vacancy ownership from the binding
config. It writes an owner-only plan file containing aggregate counts and a
selection hash. The target SQLite is opened read-only during this step.

Eligible rows require an explicit candidate membership in the same vacancy,
an HH resume ID, and a valid `YYYY-MM-DD` first-seen date. Unsafe vacancy
buckets, the reviewed historical-only unowned vacancy, dangling references,
wrong-vacancy references, wildcard candidates and invalid IDs/dates stay in
the raw import. The planner reports each reason separately. No row from the
historical-only vacancy can be promoted.

```sh
node src/r03-private-legacy-seen-promotion.js --mode plan \
  --config /private/import-config.json --plan-file /private/seen-plan.json
```

After reviewing the aggregate plan and private selection hash, the operator
may run the explicit command below. It recalculates the plan, requires exact
count/hash equality, inserts eligible rows in one `BEGIN IMMEDIATE`
transaction, and stores a durable promotion receipt in the same SQLite.
An existing first-seen date is moved earlier only when the legacy date is
earlier; later or equal legacy dates leave it unchanged. On failure the ledger
and durable receipt roll back together. A separate owner-only receipt file is
written after commit; exact replay repairs that file if the first write
fails, without inserting duplicates.

```sh
node src/r03-private-legacy-seen-promotion.js --mode promote \
  --config /private/import-config.json --plan-file /private/seen-plan.json \
  --execute
```

The final frozen import can be planned privately before the web service is
active. The operation must not be coupled to replay of the eight old
`unknown` cron outcomes. Schedules and public routes remain disabled until
their own reconciliation and acceptance gates pass.
