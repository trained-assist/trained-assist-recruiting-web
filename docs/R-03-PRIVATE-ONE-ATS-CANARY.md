# Private one-candidate ATS canary diagnostics

The disposable one-candidate ATS canary keeps an uncertain model call
`outcome_unknown`; it does not retry it. New receipts and command output add a
small diagnostic vocabulary: `assessed`, `provider_http_error`,
`provider_transport_error`, `provider_response_invalid`,
`provider_response_unusable`, or `provider_outcome_unobserved`. A valid provider
HTTP status may accompany the class. The diagnostic never contains response
bodies, exception text, prompts, credentials, or candidate details.

`replay` reads the private receipt and SQLite copy without provider access. An
older receipt with no diagnostic is reported as `legacy_unclassified`; replay
does not infer the old provider outcome. This is a diagnostic improvement for
future explicitly reviewed disposable canaries, not permission to retry the
existing unknown item. Diagnose that item from independent provider/host
evidence or leave it quarantined.

Tests use an invented SQLite snapshot and fake HTTP responses. They cover a
successful assessment, HTTP error, transport failure, privacy of the saved
receipt, replay without another call, and refusal to run twice.
