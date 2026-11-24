# Execution ledger

Before dispatching a long-running unit or a multi-unit plan, allocate **one private run directory** under the [host map's Store](../poteto-mode/references/host-capabilities.md). For example, create `$store/runs`, then use `mktemp -d "$store/runs/run-XXXXXXXX"`. Its basename is the unique run ID; a branch can serve many runs.

The coordinator alone writes `ledger.md` there. Record the run ID, repository, checkout, grant and requested scope. Workers return reports; the coordinator saves them or records a retrievable artifact path. Append a row for each transition:

`unit | attempt | child ID | checkout | branch | base SHA | head SHA | state | evidence path | pending gate`

Use full commit IDs. Mark an unknown field pending rather than inventing a value. Record dispatch before waiting; record completion, failure, hold, cancellation or supersession as observed. Tie each review verdict, ruling and parked dispute to its unit, attempt and reviewed head.

**Recovery.** Match the run ID and checkout. Verify the base and head refs, branch tip, and cited artifacts against the last row. Reconcile live or held children and inspect their effects before redispatching. A dispatched job is not a failed job. If its outcome is unknown, keep it pending; continue from the last verified gate, not from memory.

**Close.** Preserve evidence cited by tickets, PRs, rulings and handoffs. Move durable decisions to the decision record, update any evidence links and verify their new targets. Delete only this run's directory, and only when no retained record or live job still points at its evidence.
