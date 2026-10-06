# R-03 service-ladder query client

`createServiceLadderChat` provides the HTTP port for HH query generation. The host injects a private `loadToken` function and an HTTP implementation. The client calls the existing service ladder's `/v1/chat/completions` endpoint with `model=service`, a bounded 20-second ladder budget, `x-ladder-app: hh-proactive`, and one user prompt built by `createHhQueryGenerator`. It returns only the assistant message content. Token, response error text and prompt content are never included in public errors or logs.

The end-to-end invented morning fixture now uses the exact service-ladder HTTP request shape before the mock HH search. It verifies that one generated base query is cached in target SQLite and that the following scheduled search produces 100 candidates. No real ladder credential or network request is used.

A target host must supply and verify its service credential, run an authorized ladder canary and keep the token out of browser/MCP input. This PR does not install the real host service or timer.
