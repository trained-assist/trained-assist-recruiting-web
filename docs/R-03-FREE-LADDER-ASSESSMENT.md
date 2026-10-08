# R-03 free-ladder ATS assessment

`createHhAssessmentEvaluator` connects a profile/vacancy/criteria-bound search plan to the existing five-minute scoring port. It sends only the candidate's role and limited career projection, without name, contact data or HH URL, to the old HH skill's `free` ladder request shape. It parses a bounded score and explicit knockout list, rejects invented knockout criteria, caps confirmed knockout scores at 2, and maps the result to the strict `hh-result-v1` assessment DTO. Model errors and prompt text do not enter public error values.

`createFreeLadderChat` owns the HTTP request boundary with an injected private token resolver and fetch implementation. The invented morning integration now follows schedule → service-ladder query → HH two-page collection → 100-candidate snapshot → free-ladder scoring of 10 accepted candidates → assessed morning read. The score writer checks current criteria before and after the LLM call and writes only if the snapshot/input revision is still current.

No real ladder credential or model call was used. A production five-minute timer, backoff for repeatedly failed candidates, accepted-feed policy for older candidates, target credential delivery and live canary remain required before this is enabled on a host.
