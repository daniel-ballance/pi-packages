# Schedule nightly maintenance

## Configure the task

Use the T3 instructions under Wake and loop in the [host map](../poteto-mode/references/host-capabilities.md). Pass the prompt below as the task's `prompt`. Pass `{"type":"interval","everyMs":86400000}` as the structured `schedule` object, not JSON text. Confirm the returned cadence and next run time. Keep the scheduled task id so the operator can delete the task through the same host map.

Configure Full access and worktree isolation before scheduling. A prompt does not grant either permission. Select a Sonnet model offered by T3. The exact model is the operator's call. Replace `<operator-selected Sonnet model>` with its offered provider and model identity. Replace `<repository-path>` and `<approved-base-branch>` with the repository and the base authorized for maintenance PRs. Do not schedule a prompt that still has placeholders.

## Exact prompt

```text
Bump every vendored source to its upstream tip and open a maintenance PR for each checkout.

Run the maintain-p3stack skill in <repository-path>. This is an explicit bump request, not an audit-only request. Continue to bumps after the current-pins audit succeeds.

Required execution settings are Full access, worktree isolation, and <operator-selected Sonnet model>. Confirm those actual settings before any write. If Full access or isolation is absent, the model differs, or a placeholder remains, report the missing setting and stop. Start from <approved-base-branch>. Use only your own maintenance branches and worktrees. Preserve the main checkout and any existing changes.

Read packages/p3stack/skills/maintain-p3stack/SKILL.md and follow it in full. Read Opening a PR at packages/p3stack/skills/poteto-mode/playbooks/opening-a-pr.md rather than guessing a relative path. Read the manifest to enumerate all vendored sources and their shared checkouts. Audit authored p3stack rows through the registry. Run the clean-tree precondition and root gate on the current pins before moving any pin.

Stop without changing a dirty tree. Stop a source on a failed fetch, invalid ref, unexplained scope change, failed gate, or unavailable required tool. Preserve the candidate and receipts for review instead of treating a failure as clean. Check existing maintenance PRs so this run does not duplicate an open update. Continue other independent sources only from clean isolated worktrees.

For an upstream change, read the scope reports and full upstream commits. Repair only generator inputs and regenerate. Use the failure-classes reference for every failure. Add an emit or drop registry row with a reason for each unclassified path. Immediately after moving a pin, stage its vendor gitlink with git add packages/p3stack/<checkout> before any pin check. Keep sources that share a checkout in one PR and record a bump note for each affected source. Open a separate PR for each independent changed source. Require package checks, tests, registry and host checks, loader verification, the root gate, and a fresh-process smoke. Execute the routing eval as its own step when routes or chains change, even if another gate fails.

If lockfiles are stale, dispatch the dependency-refresh procedure named by the skill and stop that source. If T3 has drifted, report the observed contract and request a separate host-contract repair. Do not update T3 or mix host and dependency repairs into source PRs.

Never remove, narrow, or disable rules/lint.json deny tokens to pass a bump. Add a token rule or a registry drop instead. Never hand-edit skills, agents, or files under vendor. Repair generator inputs and use the package bump command to move pins. Never write under ~/.pi/agent, run pi install or mise install, or change the installed host. Never merge, arm auto-merge, retarget, or close a PR. Push only your own branch with hooks. No unchanged-source PRs or bump notes.

Finish with one status and full candidate SHA per vendored source, the authored registry result, PR links, receipt paths, and any blocked sources with their reasons. A clean audit alone does not prove that upstream is current. Confirm linked PRs through the host map before handback. Pass the session model explicitly to the fresh-process smoke. Leave every PR unmerged. For an unchanged bump, finish with checked candidate pins, per-source clean statuses, and an empty tree without a PR. For each changed update, finish with a URL returned by gh pr create or a BLOCKED report quoting the exact failing command, exit code, and output. Stopping after a successful audit does not complete this bump request.
```
