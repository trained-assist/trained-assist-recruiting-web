# R-03 profile-bound HH credential broker

`createPrivateHhCredentialBroker` supplies `loadCredential` and `refreshCredential` to the existing HH transport. A trusted server-side binding maps a profile ID to an owner-only token directory; neither HTTP nor MCP input selects the path. The reader accepts old JSON/plain token files and the legacy AES-256-GCM v2 envelope, and rejects symlinks, a wrong key and malformed files without returning source content in errors.

On a 401/403, the transport calls refresh once. The broker takes a per-file cross-process lock, re-reads the credential after locking, and avoids a second OAuth POST if another process already rotated it. A successful OAuth response replaces the token atomically with an encrypted v2 file (`0600`) and syncs the file and directory. A failed OAuth request leaves the old token and releases the lock. An orphaned lock after process death is **not** removed automatically; an operator must investigate before clearing it, because an in-flight refresh may have had an uncertain outcome.

Tests use invented credentials and mock HH/OAuth responses. No real token, OAuth client secret, target profile mapping or HH request was used. Production still needs private data restore, secret delivery, operator recovery for orphaned locks, authorized HH canary, scorer, timer and route cutover. The broker does not satisfy HH #187 alone.
