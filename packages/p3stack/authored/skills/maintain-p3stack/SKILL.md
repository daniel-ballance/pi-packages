---
name: maintain-p3stack
description: Audit p3stack's current pins, bump vendored sources, or revert a p3stack maintenance PR.
---

# Maintain p3stack

Select the mode from the operator's request, before running commands:

- **Audit (default).** A ref alone is an audit parameter, never permission to move a pin, open a PR or land. Run the [current-pins audit](references/audit.md) and stop with the report.
- **Bump** only on an explicit `bump` request. Run the audit, [bump the requested checkout](references/bump.md), then [land the verified PR](references/land.md) unless asked to pause. This authorizes scoped input repairs, closing confirmed superseded maintenance PRs and one revert of its own failed landing.
- **Revert** only on an explicit `revert` request naming a numbered maintenance PR, or after that bump's failed landing. Apply the [revert guard and procedure](references/revert.md) before touching a branch.

A negated verb is not authorization. Stop if the requested action or target is ambiguous. A dependency refresh or [T3 host-contract repair](references/host-repair.md) needs its own request. For an operator-requested nightly bump under T3 Code, use the [nightly setup](references/nightly.md).

Read the target repository's root and package `AGENTS.md`. **Root** means the repository root; **package** means its `packages/p3stack` directory. Keep working receipts outside the checkout; never put credentials in them. Use installed tools and [disposable loader checks](references/smoke.md), not the operator's agent settings or a host installation.

Report each source's full SHA and state: clean, landed, reverted, paused at the operator's request, or blocked. Include the authored registry result, PRs and merge commits where applicable. For a blocker give the command, exit code and relevant output.
