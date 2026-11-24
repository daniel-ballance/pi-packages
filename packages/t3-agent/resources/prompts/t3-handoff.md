---
description: Move this thread into its own new git worktree and continue there
argument-hint: "[branch name]"
---
Move this thread into its own worktree; stop this session at the handoff.
Requested branch: $@

1. Call `t3_worktree_status`. If already attached, report the worktree and stop.
2. Commit needed local changes or say what stays behind. If unpublished commits are needed, use their local `baseRef` and `startFromOrigin:false`.
3. Use the supplied name if `git check-ref-format --branch <name>` accepts it; otherwise derive a valid unused name from the task. Call `t3_worktree_handoff` last with that name and a `continuationPrompt` stating the task, progress and next step.
