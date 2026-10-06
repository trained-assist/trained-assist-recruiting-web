# Bounded RU timer/provider/restart canary

This is a disposable operational rehearsal for Recruiting #78/#81 and HH #187.
It does not enable any imported schedule, public page, or production minute
timer. It cannot satisfy the required natural cycle of the rarest schedule:
the existing `r03-private-scheduled-rehearsal` deliberately uses one query,
one page, `per_page=1`, one HH attempt and at most one ATS attempt. Its
`acceptedForMorning=false` result must never be presented as fresh.

## Boundary

Use a root-owned 0700 directory separate from the migrated DB and the
service-owned disabled web stage. The input stage receipt must be
`r03-private-schedule-stage-v1` with 11 imported disabled schedules and eight
unknown outcomes quarantined. The selection receipt must be a prior
`r03-private-scheduled-rehearsal-v1` for an already validated owned scope;
the wrapper reads its private profile and vacancy identifiers without placing
them in the timer unit, command arguments or journal. The wrapper calls the
real scheduled worker and real HH transport in the pinned release.

The new output directory must not exist at first dispatch. If a process
crashes after creating it but before writing its receipt, a later invocation
fails closed; inspect the occurrence and provider effect before any retry.
If the receipt exists, the application verifies the saved occurrence and
snapshot and returns `replayed` with zero provider requests. This is the
restart check, not a second search.

Use a one-shot transient `systemd-run --on-active` timer with a unique unit
name, a 120-second service timeout, `ProtectSystem=strict`, and a writable
path restricted to the disposable root. Verify the timer trigger and service
result, then stop the timer. The generic production unit is deliberately
not installed or enabled. Do not run this canary against the main migrated
DB or the web stage DB.

## Executed RU evidence, 2026-10-06

- Target `host1889322-1`: 7.3 GiB RAM available and 43 GiB disk free before
  the run. The pinned release was
  `5bbd27f711823d74620931e142eb00218b212ef5`. Transferred wrapper
  SHA-256 matched local bytes:
  `db9645045f4d60bec9b1e908f85cc38615a4e97b180b022a69bd8f17e76de289`.
- One transient timer `r03-hh-bounded-canary-20261006.timer` fired at
  09:07:38 UTC. Its one-shot service exited successfully and logged only
  aggregate fields: `status=succeeded`, `providerRequests=1`,
  `assessmentRequests=1`, `acceptedForMorning=false`,
  `disposableOnly=true`. The disposable receipt reports one candidate.
- A new process invoked the same wrapper and output directory after the
  timer service exited. It returned `status=replayed`,
  `providerRequests=0`, `assessmentRequests=0`.
- The disposable DB passed SQLite integrity check. It has 12 disabled
  schedules: 11 imported plus the quarantined rehearsal schedule. Eight
  imported unknown outcomes remain quarantined; one new synthetic occurrence
  succeeded in the disposable copy.
- Migrated source main-file SHA-256 remained
  `de7652627082ba4f66ac682aafc766b3625a8f567521a00ef7f45f72eb6f84c8`;
  the disabled schedule-stage main-file SHA-256 remained
  `0e44b5454c55a3cef297271f5c8714ced5cca9efffe19131ae5d857d1a9ff57e`.
  The transient timer was stopped and no Recruiting timer appears in the
  installed timer list. `trained-recruiting-r03-stage.service` remained
  disabled and inactive. Public nginx routes were not changed.

## Next acceptance gate

Run a reviewed full-query/full-pagination occurrence for every required
vacancy using the production-shaped timer and reconciled schedule authority.
Observe a natural cycle of the rarest required schedule, restart recovery,
the authenticated private page/API for both profiles, ATS backlog progress,
and no calls to the old GCP VM. Resolve or explicitly dispose of each of the
eight unknown legacy outcomes before enabling imported schedules. The
partial canary above proves only the bounded timer/provider/replay path.
