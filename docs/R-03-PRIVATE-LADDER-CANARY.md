# Private ladder preflight

`r03-private-ladder-canary.js` is an opt-in, bounded provider preflight for one
explicitly owned vacancy. It uses the verified private host binding, an ATS
context and a current saved-query cache. With the owner-only `ladder_token`, it
makes one service-ladder query-generation request and one free-ladder assessment
request. The assessment candidate is invented in code; no real candidate
name, contact, HH URL or resume is sent. The output contains only the number
of generated queries and whether a bounded assessment was accepted.

This canary does not open SQLite, persist generated queries or scores, claim a
job, run a search, enable a timer, or bind a web route. A pass proves only that
both ladder transport contracts work for the selected ATS context. It does not
certify historical candidate scores or morning snapshot freshness.
