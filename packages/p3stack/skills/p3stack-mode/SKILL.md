---
name: p3stack-mode
description: Route requests through the p3stack registry and poteto-mode workflows.
disable-model-invocation: true
---

# p3stack mode

Read [poteto-mode](../poteto-mode/SKILL.md) in full and follow it. Where these rules differ, this router wins, including over poteto-mode's Playbooks selection. Select the route before loading supporting principles or workflow skills.

## Routes

Match the request and grant below. Read the target first, then follow it. Paths are relative to this skill directory. A request to review someone else's PR uses the external review route. Review my change starts with no-comments.

| Request | Grant | Read |
| --- | --- | --- |
| Understand an existing subsystem | any | ../poteto-mode/playbooks/investigation.md |
| Find a fact outside the repository | any | ../research/SKILL.md |
| Align on a design with the human present | default | ../grill-with-docs/SKILL.md |
| Align on a design without blocking | full-autonomy | ../sharpen/SKILL.md |
| Explore design alternatives | full-autonomy | ../architect/SKILL.md |
| Map a large effort with unresolved decisions | default | ../wayfinder/SKILL.md |
| Publish a tracker spec | default | ../to-spec/SKILL.md |
| Split a spec into tracker tickets | default | ../to-tickets/SKILL.md |
| Plan a program of PRs | any | ../poteto-mode/playbooks/multi-phase-plan.md |
| Build new or changed behavior | any | ../poteto-mode/playbooks/feature.md |
| Fix a reported bug | any | ../poteto-mode/playbooks/bug-fix.md |
| Investigate measured slowness | any | ../poteto-mode/playbooks/perf-issue.md |
| Improve one measured metric repeatedly | any | ../poteto-mode/playbooks/hillclimb.md |
| Restructure code without changing behavior | any | ../poteto-mode/playbooks/refactoring.md |
| Review my change | any | ../no-comments/SKILL.md |
| Review someone else's PR | any | ../dyl-review/SKILL.md |
| Triage incoming issues or external PRs | any | ../triage/SKILL.md |
| Open a PR | any | ../poteto-mode/playbooks/opening-a-pr.md |
| Drive an existing PR to readiness | any | ../poteto-mode/playbooks/babysit.md |
| Land a verified stack when authorized | any | ../poteto-mode/playbooks/shipping.md |
| Survey codebase health | any | ../improve-codebase-architecture/SKILL.md |
| Implement a tracker ticket graph | any | ../implement-spec/SKILL.md |
| Run a standing program of PRs | any | ../poteto-mode/playbooks/orchestrate.md |
| Hand work to another tool or person | any | ../handoff/SKILL.md |
| Pause the current session | any | ../poteto-mode/playbooks/pause-safely.md |
| Resume an existing session | any | ../poteto-mode/playbooks/session-pickup.md |
| Review the session's environment | any | ../retro/SKILL.md |
| Write or change a skill | any | ../poteto-mode/playbooks/authoring-a-skill.md |
| Prepare steps only a human can perform | any | ../wizard/SKILL.md |
| Handle a task with no matching playbook | any | ../figure-it-out/SKILL.md |
| Cut a release | any | ../release/SKILL.md |
| Onboard to an existing repository | any | playbooks/onboard-brownfield.md |

## Chains

Apply each matching chain at its anchor in table order. When no failing reproduction exists, read diagnosing-bugs before the Bug fix playbook. Then continue that playbook after diagnosis.

| Playbook | Anchor | Position | Read | When |
| --- | --- | --- | --- | --- |
| ../poteto-mode/playbooks/feature.md | 2. `architect` for parallel design exploration. | after | ../tdd/SKILL.md | Use the seams named by architect. Confirm them with the human under the default grant. |
| ../poteto-mode/playbooks/bug-fix.md | Reproduce it yourself on the matching surface via the control skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. | before | ../diagnosing-bugs/SKILL.md | No failing reproduction exists yet. Then continue Bug fix from the plan step. |
| ../poteto-mode/playbooks/feature.md | 7. If the design is contested, `interrogate` before shipping. | before | ../no-comments/SKILL.md | Review completed code before code-review. |
| ../poteto-mode/playbooks/feature.md | 7. If the design is contested, `interrogate` before shipping. | before | ../code-review/SKILL.md | After no-comments. Keep standards and spec findings separate. |
| ../poteto-mode/playbooks/bug-fix.md | 6. Run **Opening a PR**. | before | ../no-comments/SKILL.md | Review completed code before code-review. |
| ../poteto-mode/playbooks/bug-fix.md | 6. Run **Opening a PR**. | before | ../code-review/SKILL.md | After no-comments. Keep standards and spec findings separate. |
| ../poteto-mode/playbooks/opening-a-pr.md | **Forge.** | before | ../poteto-mode/SKILL.md | Read Pull requests in the host capabilities when opening a PR and before handback. Follow its host integration after creation. |
| ../poteto-mode/playbooks/authoring-a-skill.md | 1. Use the skill-authoring procedure (**Author a skill** in the host capabilities). | before | ../writing-for-agents/SKILL.md | Author or modify agent-facing instructions. |

## Grants and context

Under the default grant, use the interview skills and ask the human about product choices. Under full autonomy, replace grill-with-docs and grilling with sharpen followed by architect. Infer covered choices from repository evidence and report them. Explicit operator gates and irreversible actions still pause. A tdd test seam is not a module boundary. Architect owns module boundaries, and tdd confirms the test seam within them.

Keep context focused on the selected route. Read its dependencies when their trigger applies, rather than loading every linked skill. Before handing work off or compacting, save decisions, evidence paths, and unresolved questions in durable notes.
