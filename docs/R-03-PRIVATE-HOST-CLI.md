# R-03 private host commands

`src/r03-private-host-cli.js` is a runnable entrypoint for an explicitly prepared non-GCP host. It accepts `--mode check|minute|score --config /absolute/private/config.json`. `minute` and `score` also require `--secrets /absolute/private/secrets --live-execution`; the flag prevents an accidental provider call during inspection. The secret directory contains owner-only `hh_encryption_key`, `hh_client_id`, `hh_client_secret` and `ladder_token` files. The HH profile token stays in each profile's private token directory from the host mapping.

`check` opens the private SQLite stores, verifies every enabled schedule belongs to an explicitly mapped profile/vacancy, and reports only aggregate enabled/blocked counts. It does not load credentials or call HH/LLM. `minute` composes the private plan, query generator, HH credential refresh, transport, candidate state, occurrence worker and singleton minute lease. `score` runs a bounded accepted-snapshot ATS pass for each enabled schedule through the free ladder. Outputs are structured counts and generic failure codes; no profile ID, query, token or candidate text is printed.

Example operator commands after a private config/secret rehearsal:

```sh
node src/r03-private-host-cli.js --mode check --config /private/recruiting/config.json
node src/r03-private-host-cli.js --mode minute --config /private/recruiting/config.json --secrets /private/recruiting/secrets --live-execution
node src/r03-private-host-cli.js --mode score --config /private/recruiting/config.json --secrets /private/recruiting/secrets --live-execution
```

The tests exercise the CLI with invented owner-only files and no provider dispatch. They do not prove a real backup, token, HH/ladder canary, installed timer, watchdog, route parity or GCP exit. The 11 old schedules remain disabled until their definitions and unknown outcomes are investigated and activation evidence is accepted.
