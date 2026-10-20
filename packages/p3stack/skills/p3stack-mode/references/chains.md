# Chains

| Id | Playbook | Anchor | Position | Skill | When |
| --- | --- | --- | --- | --- | --- |
| feature-seam-tests | [playbooks/feature.md](../poteto-mode/playbooks/feature.md) | 2. `architect` for parallel design exploration. | after | [tdd](../tdd/SKILL.md) | Use the seams named by architect. Confirm them with the human under the default grant. |
| bug-red-loop | [playbooks/bug-fix.md](../poteto-mode/playbooks/bug-fix.md) | Reproduce it yourself on the matching surface via the control skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. | before | [diagnosing-bugs](../diagnosing-bugs/SKILL.md) | No failing reproduction exists yet. Then continue Bug fix from the plan step. |
| feature-comment-review | [playbooks/feature.md](../poteto-mode/playbooks/feature.md) | 7. If the design is contested, `interrogate` before shipping. | before | [no-comments](../no-comments/SKILL.md) | Review completed code before code-review. |
| feature-standards-review | [playbooks/feature.md](../poteto-mode/playbooks/feature.md) | 7. If the design is contested, `interrogate` before shipping. | before | [code-review](../code-review/SKILL.md) | After no-comments. Keep standards and spec findings separate. |
| bug-comment-review | [playbooks/bug-fix.md](../poteto-mode/playbooks/bug-fix.md) | 6. Run **Opening a PR**. | before | [no-comments](../no-comments/SKILL.md) | Review completed code before code-review. |
| bug-standards-review | [playbooks/bug-fix.md](../poteto-mode/playbooks/bug-fix.md) | 6. Run **Opening a PR**. | before | [code-review](../code-review/SKILL.md) | After no-comments. Keep standards and spec findings separate. |
| opening-pr-host-link | [playbooks/opening-a-pr.md](../poteto-mode/playbooks/opening-a-pr.md) | **Forge.** | before | [poteto-mode](../poteto-mode/SKILL.md) | Read Pull requests in the host capabilities when opening a PR and before handback. Follow its host integration after creation. |
| skill-authoring-style | [playbooks/authoring-a-skill.md](../poteto-mode/playbooks/authoring-a-skill.md) | 1. Use the skill-authoring procedure (**Author a skill** in the host capabilities). | before | [writing-for-agents](../writing-for-agents/SKILL.md) | Author or modify agent-facing instructions. |
