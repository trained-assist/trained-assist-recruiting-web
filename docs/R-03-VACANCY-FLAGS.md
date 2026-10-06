# R-03 vacancy page flags

The private proactive page owns `starred` and `archived` per trusted profile and
vacancy in the same private SQLite file as cold-search schedules. The current
flags and revision are returned with `GET /api/hh/proactive/schedule`. The
browser sends that revision to `POST /api/hh/proactive/vacancy-state` for
`star`, `unstar`, `archive`, or `restore`; a stale revision receives 409.

Archiving a vacancy disables its existing schedule in the same SQLite
transaction as the flag update. Restoring it does not reactivate the schedule.
Enabling an archived vacancy is rejected until the recruiter explicitly
restores it. Candidate review status and vacancy flags are separate state.
An occurrence already claimed before archive may finish; archive prevents new
claims and does not discard an accepted result.
The legacy source's page flags still need a private import decision; this slice
does not infer them from the paused schedule definitions.

Tests use invented profile/vacancy IDs and exercise HTTP, browser commands,
stale revision, restart persistence, and archive disabling. No host unit or
public route is installed by this slice.
