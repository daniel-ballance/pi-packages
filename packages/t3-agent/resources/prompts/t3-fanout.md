---
description: Split a task into independent parts and run each as a parallel delegate in its own worktree
argument-hint: "<task>"
---
Run this task as parallel parts: $@

1. Split it into parts that change disjoint files and can each be verified alone. If it does not split that way, say so and do it in this thread.
2. Commit whatever the parts depend on: a worktree child starts from your last commit and sees no uncommitted changes.
3. Call `orchestrator_capabilities` once. Start each part with `delegate_task`, `isolation:"worktree"`, `mode:"async"`, its own `clientRequestId`, and a brief that stands alone: the goal, the files it owns, how to verify it, and to commit on its branch and report the branch name.
4. End the turn. As each result wakes you, review its branch, merge it into this thread's branch, and run the checks. Stop a part you no longer need with `task_cancel`.
5. When every part is merged and the checks pass, reply with what each part changed.
