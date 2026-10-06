# R-03 private host minute tick

`runPrivateHhMinuteTick` is the host-side entry boundary for a real HH schedule worker. An external timer calls it once per minute with the private search stack, schedule repository and worker ID. It takes a singleton SQLite lease before the tick and renews it throughout a long run. Another process skips while the first owns the lease. A lost lease is reported explicitly; release deletes only the caller's own lease. The occurrence worker independently heartbeats each HH effect and quarantines uncertain outcomes.

The tests cover a mock tick longer than its initial host lease, overlapping process suppression, foreign/expired renewal and ownership loss. No timer is installed and no live host, profile or provider is connected by this PR. A deployment still needs an authenticated private binding/configuration, process watchdog, systemd unit/timer, structured logs and alerts, plus private data and HH/ladder canaries.
