---
description: Get an independent review of this branch from another model family
argument-hint: "[focus]"
---
Return verified findings in separate Standards and Spec lists for this branch, ordered by severity within each; fix nothing unless asked.
Focus: ${@:-correctness, missed cases, tests and project standards}.

When p3stack's routing reminder is present in this request, follow the playbook it routes to for the procedure, within this stop line.
Without that reminder:

1. Resolve the repository's default branch and pin `git merge-base HEAD <default-branch>`. State whether uncommitted work is included; include in-scope staged, unstaged and untracked changes unless asked for a committed range.
2. Choose another model family with `orchestrator_capabilities`, or report it unavailable. Pass its `target` to a read-only `delegate_task` with `role:"review"`, `mode:"async"`, the pinned scope, base, goal and focus. Ask for paths, lines and evidence.
3. Follow `next`; on the completion wake read `task_status` and verify each finding against the code and tests. Report what holds up and why you rejected the rest.
