---
description: Watch a pull request from this thread and carry it to ready-to-merge
argument-hint: "[pull request URL]"
---
Carry the pull request to ready-to-merge and report readiness; do not merge it.
Pull request: ${1:-the one for the current branch}.

When p3stack's routing reminder is present in this request, follow the playbook it routes to for the procedure, within this stop line.
Without that reminder:

1. Read failing checks and unresolved reviews. Fix verified issues, push and answer the comments.
2. Call `watch_pull_request` and end the turn. On each wake, handle the change and leave the existing watch in place.
3. When checks pass, conflicts are clear and reviews are resolved, call `unwatch_pull_request` and report readiness.
