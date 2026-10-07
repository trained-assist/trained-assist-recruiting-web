# R-03 synthetic minute worker

`src/r03-minute-worker.js` is an opt-in single-host harness for the morning
candidates schedule path. It opens the SQLite schedule, job and candidate
state stores in the same private local file, validates every enabled schedule against the checked
in synthetic profile/vacancy binding, takes a singleton SQLite runner lease,
quarantines expired candidate-job dispatches, and calls the existing schedule
tick and candidate-search handlers. It uses
only `syntheticColdSearchProvider`. There is no Agent Run, HH credential, real
profile resolver, or network provider in this entrypoint.

The CLI rejects missing mode flags. It requires `--synthetic-fixture` and
`--synthetic-dry-run` together, plus exactly one of `--check` and `--once`.
The fixture is fixed at `fixtures/r03-worker-synthetic.json`; an arbitrary
external fixture path cannot be supplied. `--check` opens the stores and
checks bindings without claiming an occurrence. `--once` runs one tick. Both
emit one JSON line with `event` and bounded counts, never a candidate or
credential. A blocked schedule or newly quarantined job makes the check/tick
exit `2` after logging its degraded state; invalid configuration exits `78`.
`--at` is an ISO UTC fake clock for offline tests only.
The timer invokes `--once` directly: `--check` is an observation command and
must not be used as `ExecStartPre`, because a degraded result may need the
next tick to quarantine expired work.

```sh
mkdir -m 700 /tmp/recruiting-r03-synthetic
node src/r03-minute-worker.js --db /tmp/recruiting-r03-synthetic/r03.sqlite --check --synthetic-fixture --synthetic-dry-run
node src/r03-minute-worker.js --db /tmp/recruiting-r03-synthetic/r03.sqlite --once --synthetic-fixture --synthetic-dry-run
```

The checked-in systemd unit/timer under `ops/systemd/` are templates only.
They are gated by an explicit local `ALLOW_SYNTHETIC_R03_WORKER` file and
would execute **only synthetic fixture searches** if installed. The unit
runs as a dedicated user, gives SQLite a `0700` state directory, allows one
service invocation at a time, has a 250-second systemd timeout and runs the
CLI's 240-second hard watchdog. The internal runner lease and schedule/job
leases expire after 300 seconds. A crash or timeout therefore leaves
ambiguous work fenced and quarantined on the next tick rather than replayed.
The timer is not installed or enabled by this repository change.

The handler validates the entire enabled schedule set before claiming any
work. A non-fixture profile, vacancy, or imported legacy job ID causes a
typed configuration failure and no tick. It does not seed a schedule. Tests
create a synthetic schedule, invoke the CLI twice with a fake due time, and
reopen the database to verify one occurrence and persisted candidate results.
An HTTP test starts a new web server after the CLI exits and verifies that
`/api/hh/proactive/candidates` reads the accumulated candidate pool and latest
snapshot from that same SQLite file.
They also simulate one crash after both an occurrence claim and a provider
dispatch; later CLI invocations quarantine both rows, block the schedule,
and leave the single provider call and single job unchanged.

This is a packaging and local recovery slice. A real HH worker still needs a
trusted profile/credential binding, canonical criteria, verified provider
access, data import, real result/seen store, background scorer, reconciliation
of unknown outcomes, full route cutover, and target resource checks. The
GCP VM stop gate in [HH #187](https://github.com/trained-assist/trained-assist-hh-skill/issues/187)
is unchanged. Do not install or enable these templates as production HH work.
