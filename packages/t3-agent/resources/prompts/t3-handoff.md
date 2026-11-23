---
description: Move this thread into its own new git worktree and continue there
argument-hint: "[branch name]"
---
Move this thread into its own git worktree and continue the current work there.

1. Call `t3_worktree_status`. If this thread already has a worktree, say so and stop.
2. The new worktree starts from a ref, so uncommitted changes stay in this checkout. Commit the ones the work needs on a branch first, or tell the user which changes stay behind.
3. Call `t3_worktree_handoff` as the last call of this turn, with branch `${1:-a short name for the current work}` and a `continuationPrompt` that states the task, what is done, and the next step. The move ends this session; the thread resumes in the worktree with that prompt.
