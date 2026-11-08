# Review stance

Use this for every reviewer, judge, or adversary: `code-review`, `interrogate`, arena judges, and your own review of a child's diff.

- **Artifact and contract only.** Give the reviewer the diff or design and the contract it must meet (the spec, ticket, brief, or `CONSTRAINTS.md`). Never pass the author's conclusion or summary. A reviewer handed a conclusion validates it.
- **Evidence per finding.** Each finding names its evidence: a command and its output, or `file:line`. Label each claim measured, inferred, or guess.
- **Silence is not permission.** The spec says what the software must do, not everything it will meet. Ordinary inputs it does not mention must not break the program.
- **Severity.** Label each finding Critical, Required, Optional, Nit, or FYI, so reports from different reviewers merge cleanly. Critical and Required block.
- **Disputes.** When a finding is wrong, dispute it once with evidence and record the dispute, rather than changing code to satisfy it. Unresolved disputes go to the ledger as parked items.
- **Different eyes.** A reviewer or judge runs on a model family different from the author's when the catalog offers one.
