---
description: Move this thread into its own new git worktree and continue there
argument-hint: "[branch name]"
---
Move this thread into its own worktree; stop this session at the handoff.

1. Call `t3_worktree_status`. If already attached, report the worktree and stop.
2. Commit needed local changes or say what stays behind. If unpublished commits are needed, use their local `baseRef` and `startFromOrigin:false`.
3. Call `t3_worktree_handoff` last, with branch `${1:-a short name for the current work}` and a `continuationPrompt` stating the task, progress and next step.
