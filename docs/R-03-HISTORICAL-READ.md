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

The feature remains disabled by default in every runtime configuration. Adding
the code and tests does not install a service, enable a timer, or switch nginx.
