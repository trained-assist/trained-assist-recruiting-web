# R-03 RU disabled staging, integration head 5bbd27f

This runbook records a reversible installation of the integrated Recruiting
code on the RU host. It does **not** accept the public morning scenario. The
public nginx locations, imported schedules, timers, main migrated database,
and root-owned archive stay untouched.

## Inputs and dry run

Pin source to commit `5bbd27f711823d74620931e142eb00218b212ef5`
(Recruiting #78, hosted checks green). Produce a `git archive` tar and record
its SHA-256 before transfer; compare bytes on RU before unpacking. Use a new
root-owned `/opt/trained-assist-recruiting-web/releases/<sha>` directory.
Check Node 20, systemd 249, nginx 1.18, free loopback port 18083, free disk,
and `systemd-analyze verify`. `nginx -t` may use a temporary config; do not
reload nginx. The active route still targets the old GCP host and currently
times out.

The verified private binding input is the owner-only
`r03-final-target/r03-hh-bound/host-config.json`; its bytes match the
`readiness-correction.json` host-config digest. It contains two profiles,
two distinct legacy usernames and 11 vacancy bindings. The six private
credential files are present. A file's presence does not prove that
`legacy_page_secret` is the original `AGENT_SECRET`. No archival receipt or
independent HMAC challenge has yet established that equality; signed-link
acceptance remains closed until then. The Control Plane BFF is opt-in and
has no live issuer or durable session store.

## Reversible installation

Create a dedicated `trained-recruiting` system user with no login shell.
Copy the six bound context/proactive/token directories into a new
service-owned `/var/lib/trained-recruiting-r03-stage` tree, after rejecting
symlinks. Make a SQLite online backup of the **quarantined disposable
full-discovery database** into that tree;
never copy its main file alone while WAL may exist. Create a new owner-only
config with paths rewritten to these copies. Copy the six secret files into
the service-owned staging tree with mode 0600. Record SHA-256 of the source
main DB, source config, each source data directory manifest and each secret
before and after copying; write a private receipt with digest equality,
aggregate counts, release SHA, and no values or profile identifiers.

Install a **disabled** stage-specific systemd unit binding only
`127.0.0.1:18083`. The unit must point to the pinned release and copied
config/credentials, run as `trained-recruiting`, and restrict its writable
paths to this staging tree. It must load all **six** credential files,
including `hh_user_agent` required by the runtime (the earlier five-file
generic template omitted it). Verify unit syntax, confirm it is disabled and
inactive, and confirm port 18083 is still free. A later operator may start
the unit for loopback-only `GET /health/ready` and signed-link tests only
after the HMAC source is independently proven. Do not install a timer or
replace the three public nginx locations (`/hh/proactive`, its `app.js`, and
`/api/hh/proactive/`) in this stage.

## Rollback and acceptance

Rollback is `systemctl stop` and `disable` of the stage unit if ever started,
then removal of that unit, the pinned release and the service-owned staged
copy **only after checking their exact paths and receipt**. Re-run
`systemctl daemon-reload`; nginx needs no reload because it was not changed.
The immutable source archive and main migrated DB are outside this rollback.
The recorded source bytes and active nginx configuration must match their
pre-stage evidence.

The next gate requires a proven legacy HMAC secret and real signed-link
challenge, private page/API test for both profiles, a reviewed production
query/feedback plan, bounded ATS scoring, natural timer/restart cycle,
investigation of eight unknown legacy occurrences, BFF profile authority,
and a reviewable public route switch with rollback. A disposable discovery
success alone does not satisfy these gates.

## Executed evidence, 2026-10-06

- RU release tar SHA-256:
  `e5b0a3fefd81a8ff418fee9aacfd1807cd32395b17ecad7fc45f12a84ca6f3e0`.
  The host verified it before unpacking; `npm ci` and native SQLite rebuild
  completed. Node `v20.20.2`, systemd `249`, nginx `1.18.0`.
- Dedicated service user and owner-only staging tree were created. Two
  profile bindings, six data directories (26 files), six credential files,
  and one SQLite online backup were copied with byte checks. The private
  receipt is `/var/lib/trained-recruiting-r03-stage/receipt.json`; it stores
  source/destination digests without values or profile names. The copy is
  based on the disposable full-discovery snapshot, with 12 disabled schedules
  (11 imported plus the disabled synthetic occurrence), one successful
  occurrence and 1,688 queued assessments. SQLite integrity is `ok`.
- `systemd-analyze verify` passed for
  `trained-recruiting-r03-stage.service`; installed unit is `disabled` and
  `inactive`, with port 18083 free. There is no recruiting timer. Active
  nginx still proxies the public locations to the old GCP host.
- An isolated Node process running as `trained-recruiting` used an injected
  trusted context on ephemeral loopback. Real API read returned HTTP 200,
  body status `completed`, `freshness=latest_completed`, total 1,688,
  `assessment_pending=1688` and blocked=0; response 2,640,423 bytes in
  461 ms. Page render returned HTTP 200, 2,109,444 bytes in 359 ms.
  Another profile received HTTP 404, anonymous HTTP 401. Process RSS was
  167 MiB. Response bodies, candidate details and identifiers were not
  logged. This is a disposable render test, not a public signed-link test.
  The isolated handler created local SQLite schema metadata, so the private
  receipt records both pre-smoke and post-smoke staged DB main-file digests.
- Migrated source main-file SHA-256 stayed
  `de7652627082ba4f66ac682aafc766b3625a8f567521a00ef7f45f72eb6f84c8`;
  quarantined stage main-file SHA-256 stayed
  `0e44b5454c55a3cef297271f5c8714ced5cca9efffe19131ae5d857d1a9ff57e`.
  The disposable full-discovery source stayed byte-identical during its
  backup. No main source, old quarantine, timer or public route was changed.
