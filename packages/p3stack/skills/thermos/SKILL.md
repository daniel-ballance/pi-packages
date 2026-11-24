---
name: thermos
description: "Launch both thermo-nuclear review subagents in parallel, then synthesize their findings. Use for thermos, double thermo review, or combined bug/security and code-quality branch audits."
disable-model-invocation: true
---

# Thermos

Run the two thermo review passes as async background subagents in parallel, then synthesize their results.

## Workflow

1. Determine the review scope from the user request, PR, current branch, or relevant changed files.
2. Gather the diff and any file/context excerpts needed for reviewers to evaluate the change without guessing.
3. As the parent, start one read-only child per pass through **Delegate** in the [host capabilities](../poteto-mode/references/host-capabilities.md). Give terminal workers the installed paths below. For T3 children, inline the assigned recipe and rubric or cite commit-relative files per **Store**:
   - the [thermo-nuclear-review recipe](../../agents/thermo-nuclear-review-subagent.md) and [rubric](../thermo-nuclear-review/SKILL.md) for bugs, breakages, security, devex regressions, feature-flag leaks, and other branch-audit risks.
   - the [thermo-nuclear-code-quality-review recipe](../../agents/thermo-nuclear-code-quality-review-subagent.md) and [rubric](../thermo-nuclear-code-quality-review/SKILL.md) for maintainability, structure, file-size growth, spaghetti, abstractions, and codebase-health risks.
4. Pass each subagent the same scoped diff/file context and ask it to return prioritized findings with file references and evidence.
5. After both finish, synthesize the results with findings first, deduplicated across reviewers. Weight overlapping findings more heavily, resolve disagreements with your own judgment, and keep summaries brief.

If individual background summaries are already visible to the user, do not restate them wholesale. Surface the unified verdict, the highest-signal findings, and any remaining uncertainty.
