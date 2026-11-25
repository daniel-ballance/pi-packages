# Execution ledger

For a long-running unit, a multi-unit plan or a requested decision trail, allocate **one private run directory** under the [host map's Store](../poteto-mode/references/host-capabilities.md). For example, create `$store/runs`, then use `mktemp -d "$store/runs/run-XXXXXXXX"`. Its basename is the unique run ID; a branch can serve many runs.

The coordinator alone writes `ledger.md` there. Record the run ID, repository, checkout, grant and requested scope. Workers return reports; the coordinator saves them or records a retrievable artifact path. Use the ledger as the run's durable notes. Append one row per transition or decision, including why it was made and what the evidence showed:

`ts | unit | attempt | child ID | checkout | branch | base SHA | head SHA | state | decision | why | evidence path | result | pending gate`

Record `ts` in UTC (ISO 8601) when the decision is made or the transition occurs. Use full commit IDs. Use `n/a` for fields that do not apply, such as child ID on solo work. Mark an unknown field pending rather than inventing a value. Record dispatch before waiting; record completion, failure, hold, cancellation or supersession as observed. Correct a mistake with a superseding row. Tie each review verdict, ruling and parked dispute to its unit, attempt and reviewed head.

**Recovery.** Match the run ID and checkout. Verify the base and head refs, branch tip, and cited artifacts against the last row. Reconcile live or held children and inspect their effects before redispatching. Before retrying a write that failed or timed out, such as a comment, merge or push, read the remote state; it may have landed. A dispatched job is not a failed job. If its outcome is unknown, keep it pending; continue from the last verified gate, not from memory.

**Checkpoints.** A restart of the parent's session can interrupt its children with no completion wake. So at each scheduled checkpoint, observe every child the ledger shows as pending once, by reading its thread or run state. One read per checkpoint is not polling and does not retrieve a result; never repeat it in a loop or a sleep. If the read is inconclusive, keep the child pending, as Recovery says. For a child the host reports interrupted or stopped:

1. Stop the processes and service units it left running.
2. Record in the ledger the commits in its checkout and where they are. Push them only when the selected playbook and the grant let the parent write that branch, as when no owner holds it and no pull request is open; otherwise leave them for the next owner.
3. Count the unit as a retry. Give it to a fresh child that starts from that state only when the playbook's current gate and retry limit allow, and never during a pause.

**Close.** Preserve evidence cited by tickets, PRs, rulings and handoffs. Move durable decisions to the decision record, update any evidence links and verify their new targets. Delete only this run's directory, and only when no retained record or live job still points at its evidence.
