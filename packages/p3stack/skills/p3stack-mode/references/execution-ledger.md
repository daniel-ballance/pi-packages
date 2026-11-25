# Execution ledger

For a long-running unit, a multi-unit plan or a requested decision trail, allocate **one private run directory** under the [host map's Store](../poteto-mode/references/host-capabilities.md). For example, create `$store/runs`, then use `mktemp -d "$store/runs/run-XXXXXXXX"`. Its basename is the unique run ID; a branch can serve many runs.

The coordinator alone writes `ledger.md` there. Record the run ID, repository, checkout, grant and requested scope. Workers return reports; the coordinator saves them or records a retrievable artifact path. Use the ledger as the run's durable notes. Append one row per transition or decision, including why it was made and what the evidence showed:

`ts | unit | attempt | child ID | checkout | branch | base SHA | head SHA | state | decision | why | evidence path | result | pending gate`

Record `ts` in UTC (ISO 8601) when the decision is made or the transition occurs. Use full commit IDs. Use `n/a` for fields that do not apply, such as child ID on solo work. Mark an unknown field pending rather than inventing a value. Record dispatch before waiting; record completion, failure, hold, cancellation or supersession as observed. Correct a mistake with a superseding row. Tie each review verdict, ruling and parked dispute to its unit, attempt and reviewed head.

**Recovery.** Match the run ID and checkout. Verify the base and head refs, branch tip, and cited artifacts against the last row. Reconcile live or held children and inspect their effects before redispatching. Before retrying a write that failed or timed out, such as a comment, merge or push, read the remote state; it may have landed. A dispatched job is not a failed job. If its outcome is unknown, keep it pending; continue from the last verified gate, not from memory.

**Close.** Preserve evidence cited by tickets, PRs, rulings and handoffs. Move durable decisions to the decision record, update any evidence links and verify their new targets. Delete only this run's directory, and only when no retained record or live job still points at its evidence.
