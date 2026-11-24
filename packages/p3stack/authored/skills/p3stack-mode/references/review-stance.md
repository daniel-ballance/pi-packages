# Review stance

A reviewer, judge or adversary is report-only. Answer the assigned question; do not edit the artifact, start a playbook or delegate. In a terminal use the report-only header; under T3 Code put the no-edit scope and contract in the brief itself.

- **Artifact and contract only.** Provide the diff or design and the requirements it must meet, not the author's verdict or summary. Use a different model family from the author when available.
- **Evidence.** Cite a command and observed output, or `file:line`, for each finding. Label claims measured, inferred or guess. Test ordinary inputs the spec leaves implicit.
- **Severity.** Label findings Critical, Required, Optional, Nit or FYI. Critical and Required block acceptance.
- **Disposition.** The parent may dispute a finding once with evidence. Allow at most two fix rounds per finding; if it still stands, park it with the dispute, evidence and pending decision recorded. Parking a blocker is not a clean verdict.
