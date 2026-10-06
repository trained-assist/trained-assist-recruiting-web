# R-04 client report content and preview

The accepted-source report draft uses one allowlisted client model and a deterministic private HTML renderer. The renderer follows the established legacy section order and A4 print layout:

1. Candidate name, role, and vacancy.
2. Optional short candidate summary.
3. Work experience, including optional recruiter-entered details.
4. Optional vacancy requirement matrix (`yes`, `partial`, `no`) with comments.
5. Optional recruiter conclusion.

The accepted source currently supplies candidate name, role, vacancy, and work history. It does not supply a client-ready summary, criterion evidence matrix, or recruiter conclusion. Those fields begin empty and can be entered by the recruiter. The UI says this explicitly; no model-generated or inferred content is inserted.

The report contains no contact details, photo, video link, HH URL, internal score, risk log, correspondence, or other internal assessment. Such fields require a separately reviewed provenance and client disclosure contract before they can be added. HTML text is escaped, and the preview remains private in a sandboxed iframe. It is marked as an unsubmitted draft and is not published or sent.

This iteration restores the content structure and deterministic HTML only. Legacy report notes/style migration, model-assisted drafting, Markdown export, and publication lifecycle remain separate migration work and must not be treated as completed by the renderer.

Implementation and HTTP contract coverage: `src/accepted-report-drafts.js`, `public/client-report.html`, `public/client-report.js`, `contracts/v1-accepted-report-draft.schema.json`, `contracts/v1-accepted-report-edit.schema.json`, and `test/r04-accepted-report-drafts.test.js`.
