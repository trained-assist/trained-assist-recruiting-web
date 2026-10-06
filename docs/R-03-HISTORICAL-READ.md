# R-03 historical-only read boundary

The private web runtime may opt into a separate historical read route after an
operator supplies the exact SHA-256 of the private #74 plan receipt. The receipt
must still match the frozen migration and every selected stored payload. Only its
recommended latest files may be read. A trusted profile with
`recruiting.candidateSearch` scope and explicit vacancy ownership is required.

The optional API and page are `/api/hh/proactive/history?vacancy_id=…` and
`/hh/proactive/history?vacancy_id=…`. Their data is labelled `historical_only`;
it never enters the accepted feed, `latest_completed`, freshness, `newCount`,
or active seen. There are no candidate actions, manual runs or Agent Run calls
on this path. Invalid and quarantined files are absent, including by direct URL.

The private runtime accepts the three flags `--historical-import-config`,
`--historical-receipt`, and `--historical-receipt-sha256` together. At startup it
checks that SHA against the owner-only #74 receipt, binds the final archive and
host configuration, and revalidates every selected source file's byte receipt
against the quarantined SQLite row. An absent or changed receipt fails startup.
The standard runtime invocation has none of these flags and no history route.

The page exposes only snapshot date, candidate count, a small allowlist of
candidate fields and safe HH resume links. It has no editing controls. The
accepted results page links to it only when the exact private binding includes
that vacancy. The test-only MCP descriptor uses the same domain read and is not
published as a production capability.

The feature remains disabled by default in every runtime configuration. Adding
the code and tests does not install a service, enable a timer, or switch nginx.
