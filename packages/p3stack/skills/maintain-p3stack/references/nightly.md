# Schedule nightly maintenance

## Configure the task

Use the T3 instructions under Wake and loop in the [host map](../poteto-mode/references/host-capabilities.md). Pass the prompt below as the task's `prompt`. Pass `{"type":"interval","everyMs":86400000}` as the structured `schedule` object, not JSON text. Confirm the returned cadence and next run time. Keep the scheduled task id so the operator can delete the task through the same host map.

Configure Full access and worktree isolation before scheduling. A prompt does not grant either permission. The scheduler cannot set a model or a checkout itself. Create one dedicated maintenance thread with worktree isolation, Full access, and the selected model, and schedule the task from that thread with `bindToCurrentThread: true`. An unbound task starts each run from project defaults, which can be the main checkout. Select a Sonnet model offered by T3. The exact model is the operator's call. Replace `<operator-selected Sonnet model>` with its offered provider and model identity. Replace `<repository-path>` with the repository. Do not schedule a prompt that still has placeholders.

## Exact prompt

```text
Bump every vendored source to its upstream tip and land a maintenance PR for each checkout.

Run the maintain-p3stack skill in <repository-path>. This is an explicit bump request, not an audit-only request. Continue to bumps after the current-pins audit succeeds.

Required execution settings are Full access, worktree isolation, and <operator-selected Sonnet model>. Confirm those actual settings before any write. If Full access or isolation is absent, the model differs, or a placeholder remains, report the missing setting and stop. Start each checkout from the current origin/main. Use only your own maintenance branches and worktrees. Preserve the main checkout and any existing changes.

Refresh <repository-path> before you read the skill. If git status --porcelain=v1 --untracked-files=all prints anything, report it and stop. Otherwise run git fetch origin, git switch --detach origin/main, git submodule update --init --recursive, and ./scripts/ci-install.sh. Require exit code 0 from each command. The skill and its checks then come from current main.

Read packages/p3stack/skills/maintain-p3stack/SKILL.md and follow it in full, including Land a maintenance PR and Revert a landed update. Read Opening a PR at packages/p3stack/skills/poteto-mode/playbooks/opening-a-pr.md rather than guessing a relative path. Read the manifest to enumerate all vendored sources and their shared checkouts. Audit authored p3stack rows through the registry. Run the clean-tree precondition and root gate on the current pins before moving any pin.

Stop without changing a dirty tree. Block a checkout on a failed fetch, invalid ref, unexplained scope change, failed gate, unavailable required tool, or a candidate SHA that an earlier revert names. Open no PR for a blocked checkout. Preserve its candidate and receipts, and continue with the next checkout from current origin/main.

For an upstream change, read the scope reports and full upstream commits. Repair only generator inputs and regenerate. Use the failure-classes reference for every failure. Add an emit or drop registry row with a reason for each unclassified path. Immediately after moving a pin, stage its vendor gitlink with git add packages/p3stack/<checkout> before any pin check. Keep sources that share a checkout in one PR and record a bump note for each affected source. Open a separate PR for each independent changed source. Require package checks, tests, registry and host checks, loader verification, the root gate, and a fresh-process smoke before the PR. Execute the routing eval as its own step when routes or chains change, even if another gate fails.

Land each green PR: admin squash-merge it with its head commit matched, verify main at the merge commit from a fresh worktree with every submodule initialized, and close the maintenance PRs it supersedes. When the post-merge check fails, land a revert PR and report the original PR as reverted. Revert once. A red check after the revert is blocked.

If lockfiles are stale, dispatch the dependency-refresh procedure named by the skill and stop that source. If T3 lacks a required capability or has incompatible behavior, report the evidence and request a separate host-contract repair. Installed release and bridge-hash differences alone are not failures and do not authorize fingerprint refreshes. Do not update T3 or mix host and dependency repairs into source PRs.

Never remove, narrow, or disable rules/lint.json deny tokens to pass a bump. Add a token rule or a registry drop instead. Never hand-edit skills, agents, or files under vendor. Repair generator inputs and use the package bump command to move pins. Never write under ~/.pi/agent, run pi install or mise install, or change the installed host. Push only your own branches with hooks. Close only superseded maintenance PRs. No unchanged-source PRs or bump notes.

Finish with one status per vendored source: clean, landed, reverted, or blocked, with the full candidate SHA. Include the authored registry result, PR links, merge commits, closed superseded PRs, receipt paths, and the reason for each blocked source. A clean audit alone does not prove that upstream is current. Pass the session model explicitly to the fresh-process smoke. For an unchanged bump, finish with checked candidate pins, per-source clean statuses, and an empty tree without a PR. For a blocked checkout, quote the exact failing command, exit code, and output. Stopping after a successful audit or with an open maintenance PR does not complete this bump request.
```
