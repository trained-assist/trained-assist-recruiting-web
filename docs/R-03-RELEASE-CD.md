# Recruiting Web release artifact and disabled RU staging

The `Recruiting release artifact` workflow runs the real repository tests and
packages the checked-out Git commit as `source.tar`. `manifest.json` binds the
40-character source commit to the archive SHA-256. The packaging command
rejects a different checked-out HEAD; verification checks the digest, Git
archive commit header, member paths/types and required runtime files. The
artifact contains public source only. It carries no HH tokens, profile data,
private config, SSH key or deployment credential. Pull request artifacts
are review material; promote a chosen immutable commit only after its hosted
checks pass and the artifact digest is recorded in the card.

The RU operator downloads the artifact from its exact GitHub Actions run and
supplies the approved archive SHA-256 independently from that run. A public
`manifest.json` inside the same download is not independent approval. The
host's own account/SSH access is used to transfer the two files and this
reviewed installer; GitHub Actions has no host credential. Run `verify` on
the operator machine before transfer:

```sh
python3 ops/r03-release.py verify \
  --archive source.tar --manifest manifest.json \
  --approved-sha256 "$APPROVED_ARCHIVE_SHA256"
```

On RU, use the same reviewed `ops/r03-release.py` at the approved source
revision. Keep the machine ID digest in the private operator record. The
command requires root, the exact expected hostname and SHA-256 of
`/etc/machine-id`, the existing disabled and inactive staging unit, all six
private credential files, the separate private config/receipt, inactive HH
timers and an unused `127.0.0.1:18083`. It hashes active nginx configuration
before and after. It does not read or print credential values. The checked
archive is extracted to a new root-owned release directory. Locked npm
production dependencies and native SQLite are installed. A unit rendered
with the exact commit SHA is syntax-checked, the previous unit is backed up,
then the new unit is installed **disabled and inactive**. No timer, nginx
route, production database or public session is changed.

```sh
python3 ops/r03-release.py stage \
  --archive source.tar --manifest manifest.json \
  --approved-sha256 "$APPROVED_ARCHIVE_SHA256" \
  --expected-hostname "$APPROVED_HOSTNAME" \
  --expected-machine-id-sha256 "$APPROVED_MACHINE_ID_SHA256"
```

The root-only receipt lives at
`/var/lib/trained-assist-recruiting-release-cd/<sourceSha>.json`; it records
source/artifact/unit/nginx digests and status without identities or secrets.
If the unit changes unexpectedly, the script refuses rollback. For a staged
revision, rollback restores the exact prior unit and runs `daemon-reload`:

```sh
python3 ops/r03-release.py rollback \
  --source-sha "$STAGED_SOURCE_SHA" \
  --expected-hostname "$APPROVED_HOSTNAME" \
  --expected-machine-id-sha256 "$APPROVED_MACHINE_ID_SHA256"
```

Rollback leaves the immutable release directory and private staged state
for audit. It never starts a unit. This pipeline prepares a versioned,
reversible disabled stage; production CD remains gated on accepted profile
authority/Connected App login, private page and API checks for two profiles,
HH worker and natural timer acceptance, and a separately reviewed public
nginx switch with rollback. See HH issue #187 for current evidence.
