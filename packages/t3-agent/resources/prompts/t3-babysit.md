---
description: Watch a pull request from this thread and carry it to ready-to-merge
argument-hint: "[pull request URL]"
---
Carry pull request ${1:-for this branch (find it with `gh pr view --json url`)} to ready-to-merge, with T3 waking this thread on each change.

1. Handle what is already there: read the unresolved review comments and failing checks. Fix what is right, push, and answer each comment with what changed or why it stays.
2. Call `watch_pull_request`, then end the turn.
3. On each wake, handle what woke you the same way, push, and end the turn. The watch stays on across wakes.
4. A wake is not a merge decision. When required checks pass and no review thread is unresolved, say the pull request is ready, then call `unwatch_pull_request`. Merge only when the user asked you to.
