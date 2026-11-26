---
description: Watch a pull request from this thread and carry it to ready-to-merge
argument-hint: "[pull request URL]"
---
Carry the pull request to ready-to-merge and report readiness; do not merge it.
Pull request: ${1:-the one for the current branch}.

When p3stack's routing reminder is present in this request, follow the playbook it routes to for the procedure, within this stop line.
Without that reminder:

1. Check the PR on the forge. If checks pass, conflicts are clear and reviews are resolved, go to step 3.
2. Fix verified failures, push and answer unresolved comments. Recheck the PR. If ready, go to step 3. If either `watch_pull_request` or `unwatch_pull_request` is unavailable, report the current forge status and what remains, then stop. Otherwise call `watch_pull_request` and read its result. On `watching: false`, report the current state and stop. If it says checks already pass, recheck readiness now and go to step 3 if ready. Yield only for a remaining blocker that can trigger a wake; otherwise remove your watch and report the blocker. Handle each wake without rearming.
3. At readiness, remove any watch you armed with `unwatch_pull_request` and report.
