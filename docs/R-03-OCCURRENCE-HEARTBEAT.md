# R-03 long search occurrence heartbeat

HH resume pagination, OAuth refresh and query generation can take longer than the initial five-minute occurrence lease. `SqliteColdSearchScheduleRepository.renewOccurrenceLease` now extends the running occurrence and its owning schedule together in one SQLite transaction. It requires the exact worker, an unexpired matching pair and a strictly later deadline. `createDurableHhOccurrenceWorker` renews while its search awaits provider work and stops the timer before leaving the occurrence.

A successful long mock search finishes once after several renewals. If the heartbeat fails, even a committed candidate snapshot is marked `outcome_unknown`, remains hidden from the morning feed and blocks another HH dispatch until exact reconciliation. An expired or foreign worker cannot renew or finish. Tests use short fake leases and invented candidates; no live HH call was made.

This protects the occurrence lease, not the host's singleton minute-timer lease. The host timer still needs its own bounded execution, liveness/renewal policy, watchdog, and operational alerting before production activation.
