# Schedule a nightly bump (T3 Code only)

Use **Wake and loop** in the [host map](../poteto-mode/references/host-capabilities.md). Resolve the `swarm workers` role against the live catalog and confirm the operator's selected identity and thinking level. Configure a dedicated thread with that model, Full access and worktree isolation before scheduling. The prompt cannot grant these settings.

Bind the task to that thread with `bindToCurrentThread: true`; pass `{"type":"interval","everyMs":86400000}` as a structured schedule. Confirm the returned cadence and next run time; retain the task ID for cancellation. Replace both placeholders before scheduling.

```text
Bump every vendored source to its upstream tip and land a maintenance PR for each changed checkout.

Require Full access, worktree isolation, and <selected provider/model:thinking> before any write. Work from the repository root <repository-path>. Stop on missing settings, a nonempty git status --porcelain=v1 --untracked-files=all, or a placeholder. In this isolated checkout fetch origin, switch detached to origin/main, initialize submodules recursively, and run ./scripts/ci-install.sh. Stop on failure.

Read packages/p3stack/skills/maintain-p3stack/SKILL.md at that revision. Follow its explicit bump branch, including the current-pins audit and both sides of landing. Do not stop at a successful audit. Keep independent checkouts in separate PRs; write one bump note per PR covering every source in its checkout. Stop the affected checkout on a failed gate or a previously reverted tip. Preserve nonsecret evidence, leave the operator's tree and installed host unchanged, and continue other checkouts from current origin/main. Report all source SHAs and statuses, landed or reverted PR links and blockers.
```
