# Child delegation

Use a child for bounded, non-trivial work. Follow the branch for the current host; skill prose naming `subagent_*` tools describes the Pi CLI branch.

## T3 Code

Use T3's `orchestrator_capabilities` to choose an available exact provider/model, then `delegate_task` with a bounded task and explicit working directory in the prompt. Retain each `taskId`. Prefer async delegation; issue independent tasks before waiting. Completion wakes the parent, so end the turn when nothing else is ready. Use `task_status` when a result is needed mid-turn, and `task_cancel` to interrupt active work. Verify returned reports and artifacts before aggregating. A new review round uses a new `delegate_task` call with the original brief, prior findings, responses, and unresolved objections, not a message to the backing child thread. Use a distinct `clientRequestId` per round, stable across retries. Top-level threads are not delegated tasks.

## Pi CLI

First call `subagent_catalog` to see usable exact models, tools, and the live-child limit. Compose one focused child with `subagent_spawn`, selecting only the tools it needs and an explicit task and working directory. Parallelize only independent tasks and stay within the catalog limit. With nothing else to do this turn, end your turn; finished children's reports wake you. Call `subagent_wait` for the selected IDs only when your next step in this turn needs the results. It returns their new reports. Inspect replies, errors, and requested artifacts, and `subagent_read` a child whose `unread` is above 0. Verify the result; completion is not proof. Call `subagent_close` for every child after reading it, including failed work.

If catalog or spawn is unavailable, or the task has no retrieval tools available to the child, do the work directly or state the limitation. Do not assume a fallback model or child composition: unavailable catalog entries are not silently substituted.
