# Private HH binding and one-request canary

The host operator first runs `r03-private-hh-binding.js` against the verified
`final_frozen` import config. It checks the archive SHA-256 and byte count,
rejects unsafe tar members, and copies only explicitly owned ATS context,
saved queries, comments and sealed tokens into a new owner-only staging tree.
Its output is an aggregate count of owned vacancies whose saved search plan is
ready or blocked. The immutable archive and imported candidate database are
not changed. Historical unowned scopes stay quarantined in the archive.

The generated `host-config.json` binds each source profile to its authoritative
target profile and exact owned vacancy IDs. Its directory and files must stay
mode 0700 and 0600 respectively. The separate owner-only secrets directory
requires `hh_encryption_key` and `hh_user_agent` for the canary. The contact
header has the shape `app/version (contact@example.test)`; the production
minute/web runtime also requires `hh_client_id` and `hh_client_secret` for
credential refresh. No secret or token belongs in Git or CLI output.

The operator may call `r03-private-hh-canary.js --execute` with the generated
config, secrets directory, and an explicitly owned profile/vacancy. It checks
the ATS and current saved-query hash, decrypts only that profile's token, and
sends one `GET /resumes` with `page=0`, `per_page=1` and a contact-bearing
`User-Agent`/`HH-User-Agent`. It makes no refresh, query generation, schedule
claim, database write, or second HH request. Output contains only response
status and aggregate counts. A rejected token stays rejected until credential
issuer and refresh bindings are verified separately.

Neither command starts a timer, web process or public route. A successful
canary is only a transport preflight; it is not evidence of a completed cold
search, accepted snapshot or reconciled historical occurrence.
