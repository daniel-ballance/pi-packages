# Show me your work

Audit a run's decisions and the evidence behind them.

Use the run's [execution ledger](../p3stack-mode/references/execution-ledger.md) as the decision log. Start it if the task calls for a trail and none exists. Review the recorded rows and their evidence at handoff.

## Optional TSV export

For a reviewer who needs a portable copy, export the relevant ledger rows to a fresh TSV, one row per decision. Cells stay single-line. Evidence is a pointer, not prose.

Copy `../p3stack-mode/references/show-me-your-work/references/decision-log-template.tsv` (the header row) to start a clean log. Columns:

- **ts.** ISO8601 timestamp.
- **phase.** The phase or workstream.
- **decision.** What was chosen or done, one line.
- **why.** The reason in plain words. If a principle drove it, say it plainly, not as a jargon tag.
- **evidence.** A link or path that proves it: commit SHA, PR number, `file:line`, or an artifact, trace, or screenshot path. Never a paragraph.
- **result.** The outcome or predicate state: `tests green`, `reverted`, `pixel-diff 0`, `INCONCLUSIVE`, `open`.

An example, plain-spoken so a reviewer reads it at a glance.

```
ts	phase	decision	why	evidence	result
2026-05-24T09:02:00Z	frame	counted the work first, about 100 components and roughly 75 hours	wanted to know the size before starting a long run	commit 3a9f1c2	found 5 things to sort out before starting
2026-05-24T09:40:00Z	harness	took screenshots of the old version before changing anything	so we can compare old against new and catch any visual change	scripts/snapshot.sh, baseline/	saved 120 reference screenshots
2026-05-24T11:15:00Z	widget	moved the widget styles over without changing how it looks	keep the change small and the result identical	commit 7c21e0a, pixel-diff 0	looks identical, tests pass
2026-05-24T12:30:00Z	widget	threw out a helper's work because its screenshots were blank	checked the real files instead of trusting its summary	worktree reset	reverted, tightened the instructions for next time
```

## Export a row

Use `../p3stack-mode/references/show-me-your-work/scripts/log.sh <logfile> <ts> <phase> <decision> <why> <evidence> <result>` to write selected ledger rows to a fresh export. Copy `ts` from the row and use its `unit` for `phase`. The helper writes the header on first use, strips stray tabs and newlines, and quotes cells that might be spreadsheet formulas. Keep the reviewed commit and a retrievable evidence pointer with each claim.

## Where it lives

Keep the recovery ledger private. Share only the export when the handoff needs a durable trail. Remove private details and check that its evidence links resolve for the recipient before retiring the run directory.

## Rules

- Correct the ledger first, then regenerate the export.
- Prefer evidence produced by committed scripts over hand-made one-offs (the [encode-lessons-in-structure](../poteto-mode/references/principle-encode-lessons-in-structure.md) reference).

## Audit the ledger

Before handoff, check the rows for this run against the cited artifacts at the recorded head. For a transcript check, use only the run's in-scope [Session history](../poteto-mode/references/host-capabilities.md#session-history).

- Check that every row maps to a real decision or action.
- Check that each row's evidence resolves and shows what the row claims.
- Flag a fork, pivot, or abandoned approach that shaped the work but is missing from the ledger.

As a reviewer, return gaps and corrections to the coordinator. The coordinator appends a superseding row for a bad claim. Mark claims with missing evidence unverified.

## Cross-model review of the trail

Before handing back, spawn a subagent on a different model family from the one that did the work. Self-review is not a substitute. The subagent checks the ledger rows against the cited evidence and flags what the user should pay attention to. Not a redo of the work, a scan for what's suboptimal or risky. Resolve each subagent's role per the Subagents section of the **poteto-mode** skill.

- Decisions logged with weak or absent evidence.
- Verification skipped or claimed without evidence at the reviewed head.
- Choices that look risky in hindsight (premature, scope-creeping, papering over a symptom).
- Gaps the user would otherwise miss on a casual skim.

Every reply for a run that produced a trail ends with an "Attention" section. Lead with the reviewer's model on its own line (`reviewed by <model>`), then list each flag pointing to specific rows or moments. "No flags" is a valid value. The model name is not.

## Reviewing the trail

Read top to bottom, follow the evidence pointers, spot-check. GitHub renders a committed TSV as a table. `column -s$'\t' -t decisions.tsv` renders it in a terminal.

## Composing this skill

Other skills record decisions in the execution ledger. Use this reference to review or share them.
