---
description: Get an independent review of this branch from another model family
argument-hint: "[focus]"
---
Return verified findings on this branch, ordered by severity; fix nothing unless asked.
Focus: ${@:-correctness, missed cases, tests and project standards}.

When p3stack's routing reminder is present in this request, follow the playbook it routes to for the procedure, within this stop line.
Without that reminder:

1. Use `orchestrator_capabilities` to choose a reviewer from another model family. Send a read-only `delegate_task` with `role:"review"`, `mode:"async"`, the base, goal, scope and focus. Ask for findings with paths, lines and evidence.
2. End the turn. On completion, check each finding against the code and tests. Report what holds up and why you rejected the rest.
