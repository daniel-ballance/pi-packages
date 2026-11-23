---
description: Get an independent review of this branch from another model family
argument-hint: "[focus]"
---
Get an independent review of this branch's changes. Focus: ${@:-correctness, missed cases, tests, and the project's documented standards}.

1. Call `orchestrator_capabilities` and choose a strong model from a model family other than yours. Name it in your reply.
2. Call `delegate_task` with `role:"review"`, `mode:"async"` and a brief that stands alone: the repository path, the base to diff against (`git merge-base HEAD <default branch>`), the goal of the change, the focus above, "do not edit files", and a report of findings ordered by severity, each with path, line and evidence. The reviewer shares this checkout, so it also sees uncommitted changes.
3. End the turn. When the review wakes you, check each finding against the code. Fix the real ones yourself and list the ones you rejected, with the reason. A second round is a new `delegate_task` carrying the brief and the previous findings.
