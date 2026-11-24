---
description: Split a task into independent parts and run each as a parallel delegate in its own worktree
argument-hint: "<task>"
---
Split the task, delegate disjoint parts and merge the verified results locally; open no pull request.
Task: $@

When p3stack's routing reminder is present in this request, follow the playbook it routes to for the procedure, within this stop line.
Without that reminder:

1. Split by file ownership and independent checks. If the work cannot be split safely, do it in this thread.
2. Commit any prerequisites. Use `orchestrator_capabilities`, then one async `delegate_task` per part with `isolation:"worktree"`, its own `clientRequestId`, goal, files and checks. Ask for a commit and branch name.
3. Finish dispatching the wave, keep each `taskId` and follow its `next`. Yield while waiting. On a completion wake, read `task_status`, verify the part and merge it locally. Cancel unneeded parts with `task_cancel`. Run the combined checks and report the result.
