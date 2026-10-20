# Schedule nightly maintenance

## Configure the task

Use the T3 instructions under Wake and loop in the [host map](../poteto-mode/references/host-capabilities.md). Pass the prompt below as the task's `prompt`. Pass `{"type":"interval","everyMs":86400000}` as the structured `schedule` object, not JSON text. Confirm the returned cadence and next run time. Keep the scheduled task id so the operator can delete the task through the same host map.

Configure Full access and worktree isolation before scheduling. A prompt does not grant either permission. Select a Sonnet model offered by T3. The exact model is the operator's call. Replace `<operator-selected Sonnet model>` with its offered provider and model identity. Replace `<repository-path>` and `<approved-base-branch>` with the repository and the base authorized for maintenance PRs. Do not schedule a prompt that still has placeholders.

## Exact prompt

```text
Run the maintain-p3stack skill in <repository-path> with an explicit request to bump every vendored source to its upstream tip after the current-pins audit succeeds.

Required execution settings are Full access, worktree isolation, and <operator-selected Sonnet model>. Confirm those actual settings before any write. If Full access or isolation is absent, the model differs, or a placeholder remains, report the missing setting and stop. Start from <approved-base-branch>. Use only your own maintenance branches and worktrees. Preserve the main checkout and any existing changes.

Read packages/p3stack/skills/maintain-p3stack/SKILL.md and follow it in full. Read the manifest to enumerate all vendored sources and their shared checkouts. Audit authored p3stack rows through the registry. Run the clean-tree precondition and root gate on the current pins before moving any pin.

Stop without changing a dirty tree. Stop a source on a failed fetch, invalid ref, unexplained scope change, failed gate, or unavailable required tool. Preserve the candidate and receipts for review instead of treating a failure as clean. Check existing maintenance PRs so this run does not duplicate an open update. Continue other independent sources only from clean isolated worktrees.

For an upstream change, read the scope reports and full upstream commits. Repair only generator inputs and regenerate. Use the failure-classes reference for every failure. Keep sources that share a checkout in one PR and record a bump note for each affected source. Open a separate PR for each independent changed source. Require package checks, tests, registry and host checks, loader verification, the root gate, and a fresh-process smoke. Run the routing eval when routes or chains change.

If lockfiles are stale, dispatch the dependency-refresh procedure named by the skill and stop that source. If T3 has drifted, report the observed contract and request a separate host-contract repair. Do not update T3 or mix host and dependency repairs into source PRs.

Never hand-edit skills or agents. Never write under ~/.pi/agent, run pi install or mise install, or change the installed host. Never merge, arm auto-merge, retarget, or close a PR. Push only your own branch with hooks. No unchanged-source PRs or bump notes.

Finish with one status and full candidate SHA per vendored source, the authored registry result, PR links, receipt paths, and any blocked sources with their reasons. A clean audit alone does not prove that upstream is current. Confirm linked PRs through the host map before handback. Leave every PR unmerged.
```
