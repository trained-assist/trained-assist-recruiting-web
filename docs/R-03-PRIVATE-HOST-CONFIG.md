# R-03 private host binding

The schedule worker needs a trusted mapping from its profile ID to the restored ATS context, proactive data, HH token directory and owned vacancy IDs. `loadPrivateHostConfig` reads an owner-only JSON file from an owner-only directory, rejects symlinks, extra fields, duplicate profiles/vacancies and unsafe paths, and returns only exact-map binding and ownership ports. Browser or MCP input never selects a filesystem path. The SQLite path is also restricted to an owner-only directory.

`loadPrivateHostSecret` reads a named owner-only credential file through a no-follow descriptor. It is intended for host-provided HH OAuth client settings, encryption key and ladder token; this repository contains no real values. The checked-in tests use invented IDs and directories only.

Example shape, with placeholders only:

```json
{
  "version": "r03-private-host-v1",
  "dbPath": "/private/recruiting/state.sqlite",
  "profiles": [{
    "profileId": "profile_example",
    "vacancyIds": ["vacancy_example"],
    "contextDirectory": "/private/recruiting/profiles/example/context",
    "proactiveDirectory": "/private/recruiting/profiles/example/proactive",
    "tokenDirectory": "/private/recruiting/tokens/example"
  }]
}
```

The file itself and its parent must be private (`0600` and `0700`). This module does not prove that source files were restored correctly or that a profile is authorized in the public web session. Both require separate evidence before cutover.
