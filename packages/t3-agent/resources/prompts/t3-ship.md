---
description: Commit, push and open a pull request, then link it to this T3 thread
argument-hint: "[notes for the pull request]"
---
Open a pull request, link it to this T3 thread and return its URL; do not watch or merge it.
Notes: ${@:-none}.

When p3stack's routing reminder is present in this request, follow the playbook it routes to for the procedure, within this stop line.
Without that reminder:

1. Run the project's required checks and fix failures. Use a feature branch, commit the work and push with upstream tracking.
2. Open the pull request using the project's forge and PR template. Call `link_pull_request` with its URL.
3. Reply with the URL and where the reviewer should start.
