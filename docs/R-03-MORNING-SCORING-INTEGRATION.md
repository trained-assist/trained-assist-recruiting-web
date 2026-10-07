# R-03 morning result and background score integration

`createDurableHhOccurrenceWorker.morningResults` reads only a succeeded scheduled occurrence and now overlays the validated ATS assessment from the same private SQLite candidate state. Candidate order remains the original pre-score order. `freshness` remains tied to occurrence status: a newer unknown run shows the last accepted result as `latest_run_incomplete`, never as fresh. The score and search snapshot survive process restart.

`runAcceptedMorningScoringTick` is the offline bridge for a five-minute injected evaluator. It checks the trusted profile/vacancy through `morningResults`, compares the accepted job with the latest stored snapshot and passes that job as a fence into the scoring writer. A snapshot committed while its occurrence is unknown is held from scoring and morning display until reviewed reconciliation. A later search that appears during evaluation is rejected by the scorer's SQLite compare-and-swap. No timer, network client or route is enabled by importing or calling this bridge with test ports.

The test covers scheduled mock HH collection, a five-minute assessment, restart and morning read, a newer unknown occurrence, scope denial and an unknown occurrence with a committed snapshot. All identifiers and candidate details are invented.

Remaining work: the current morning read is a single accepted search snapshot, not the legacy accumulated per-vacancy candidate feed. It lacks reviews, comments and pagination over historical candidates. The evaluator, criteria revision owner, singleton timer/lease, authenticated public page/API, private data import and real host acceptance are still absent. The stop gate in HH #187 remains open.
