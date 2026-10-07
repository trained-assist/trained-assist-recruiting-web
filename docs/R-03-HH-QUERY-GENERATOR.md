# R-03 HH search query generation

`createHhQueryGenerator` supplies the previously injected `generateQueries` port of the review-aware plan. It asks an injected service-ladder chat client for specialized HH search terms based on one vacancy's ATS title, context, criteria, knockout factors and recruiter comments. It validates the JSON array, length and duplicates. An off-topic or malformed answer falls back only to the vacancy title and highest-weighted criteria, matching the old search's fail-safe direction. An LLM transport error or vacancy with no useful anchor rejects the run before HH dispatch; errors do not expose prompt text.

The tests use invented vacancy data and a fake chat client. This module does not implement the ladder HTTP client, own its credential, regenerate a missing/stale legacy base query cache, or install a timer. Those ports and private data must be supplied before live activation.
