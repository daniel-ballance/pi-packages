---
name: p3stack-mode
description: Route requests through the p3stack registry and poteto-mode workflows.
disable-model-invocation: true
---

# p3stack mode

First read poteto-mode in full at `<this file's directory>/../poteto-mode/SKILL.md`. Replace `<this file's directory>` with the absolute directory containing the p3stack-mode/SKILL.md you just read. For example, if this file is `<package>/skills/p3stack-mode/SKILL.md`, read poteto-mode at `<package>/skills/poteto-mode/SKILL.md`. Use that same directory substitution for every Read path below.

Finish the poteto-mode read before any other tool call. Follow it, except this router wins where its rules differ. Then select the route and applicable chains before reading any supporting skill. Read only the selected first target next.

## Grants

Use the grant the extension states in the system prompt ("Grant: default" or "Grant: full-autonomy"). An explicit request for full autonomy in the user's message raises it for that task. Without the extension's line, infer it from the request. Full autonomy selects full-autonomy rows, not default rows. Under full autonomy, design starts with sharpen, then architect. Replace grill-with-docs and grilling with that sequence. Infer covered choices from repository evidence and report them. Under the default grant, use the interview skills and ask the human about product choices. Explicit operator gates and irreversible actions still pause.

## House policies

These settle conflicts between the routed skills, and they win over any of them.

1. **Authority.** Internal team actions (team chat, ticket updates, starting evals) proceed. Messages to customers or anyone outside the team, deploys, force-pushes to shared branches, and data deletion pause. Under full autonomy, a call only the operator can make gets a default, a report, and a plain statement of what they could choose instead.
2. **Questions.** Before asking the human, sort the question. A fact: look it up or delegate the lookup. Observable by running something: the Prototype playbook, judged by you. Easier to show than to describe: the Prototype playbook, with a prototype the human tries. A preference no experiment settles: ask. Grilling sorts every question the same way, opens with one open question about why the change is wanted, with no suggested answers, and stops when the frontier is empty or your written hypothesis reaches about 95% confidence.
3. **Validation.** Validate at trust boundaries and before dangerous side effects. Inside them, trust the types.
4. **Migration.** With external consumers, persisted data, or staged deploys, sequence expand–contract. When every caller is internal and in this repository, migrate and delete in one wave.
5. **Testing.** Red before green at the seams architect agreed. regression-test covers cheap bug paths. When the only available test would couple to the implementation, write none and say so in the report. Prototypes and spikes take no tests.
6. **Review independence.** Give a reviewer or judge the artifact and its contract, never the author's conclusion. Every finding names its evidence. A spec's silence is not permission for ordinary inputs to break the program. Dispute a wrong finding with evidence and record the dispute, rather than churning code to satisfy it.
7. **Context.** Give new work to a fresh child with the original goal, the brief, and the prior report. Resume a child only to reuse live state: uncommitted changes or a running process.
8. **Style.** unslop governs replies and PR bodies. Where one of its punctuation rules makes a sentence worse, follow technical-writing and fix the sentence another way.

## Routes

Match the request and grant below. After poteto-mode, read the target and follow it. A request to review someone else's PR uses the external review route. Review my change starts with no-comments.

| Request | Grant | Read |
| --- | --- | --- |
| Understand an existing subsystem | any | `<this file's directory>/../poteto-mode/playbooks/investigation.md` |
| Find a fact outside the repository | any | `<this file's directory>/../research/SKILL.md` |
| Align on a design with the human present | default | `<this file's directory>/../grill-with-docs/SKILL.md` |
| Align on a design without blocking | full-autonomy | `<this file's directory>/../sharpen/SKILL.md` |
| Explore design alternatives | full-autonomy | `<this file's directory>/../architect/SKILL.md` |
| Map a large effort with unresolved decisions | default | `<this file's directory>/../wayfinder/SKILL.md` |
| Publish a tracker spec | default | `<this file's directory>/../to-spec/SKILL.md` |
| Split a spec into tracker tickets | default | `<this file's directory>/../to-tickets/SKILL.md` |
| Plan a program of PRs | any | `<this file's directory>/../poteto-mode/playbooks/multi-phase-plan.md` |
| Build new or changed behavior | any | `<this file's directory>/../poteto-mode/playbooks/feature.md` |
| Fix a reported bug | any | `<this file's directory>/../poteto-mode/playbooks/bug-fix.md` |
| Investigate measured slowness when a timing or throughput number is given | any | `<this file's directory>/../poteto-mode/playbooks/perf-issue.md` |
| Improve one measured metric repeatedly | any | `<this file's directory>/../poteto-mode/playbooks/hillclimb.md` |
| Restructure code without changing behavior | any | `<this file's directory>/../poteto-mode/playbooks/refactoring.md` |
| Review my change | any | `<this file's directory>/../no-comments/SKILL.md` |
| Review someone else's PR | any | `<this file's directory>/../dyl-review/SKILL.md` |
| Triage incoming issues or external PRs | any | `<this file's directory>/../triage/SKILL.md` |
| Open a PR | any | `<this file's directory>/../poteto-mode/playbooks/opening-a-pr.md` |
| Drive an existing PR to readiness | any | `<this file's directory>/../poteto-mode/playbooks/babysit.md` |
| Land a verified stack when authorized | any | `<this file's directory>/../poteto-mode/playbooks/shipping.md` |
| Survey codebase health | any | `<this file's directory>/../improve-codebase-architecture/SKILL.md` |
| Implement a tracker ticket graph | any | `<this file's directory>/../implement-spec/SKILL.md` |
| Run a standing program of PRs | any | `<this file's directory>/../poteto-mode/playbooks/orchestrate.md` |
| Hand work to another tool or person | any | `<this file's directory>/../handoff/SKILL.md` |
| Pause the current session | any | `<this file's directory>/../poteto-mode/playbooks/pause-safely.md` |
| Resume an existing session | any | `<this file's directory>/../poteto-mode/playbooks/session-pickup.md` |
| Review the session's environment | any | `<this file's directory>/../retro/SKILL.md` |
| Write or change a skill | any | `<this file's directory>/../poteto-mode/playbooks/authoring-a-skill.md` |
| Prepare steps only a human can perform | any | `<this file's directory>/../wizard/SKILL.md` |
| Handle a task with no matching playbook | any | `<this file's directory>/../figure-it-out/SKILL.md` |
| Cut a release | any | `<this file's directory>/../release/SKILL.md` |
| Onboard to an existing repository | any | `<this file's directory>/../p3stack-mode/playbooks/onboard-brownfield.md` |
| Audit p3stack pins, refresh its upstream sources, or revert a p3stack maintenance PR | any | `<this file's directory>/../maintain-p3stack/SKILL.md` |

## Chains

Apply each matching chain at its anchor in table order. For a reported bug without a failing reproduction, the first target is diagnosing-bugs, before even reading the Bug fix playbook. Continue Bug fix after diagnosis.

| Playbook | Anchor | Position | Read | When |
| --- | --- | --- | --- | --- |
| `<this file's directory>/../poteto-mode/playbooks/feature.md` | 2. `architect` for parallel design exploration. | after | `<this file's directory>/../tdd/SKILL.md` | Use the seams named by architect. Confirm them with the human under the default grant. |
| `<this file's directory>/../poteto-mode/playbooks/bug-fix.md` | Reproduce it yourself on the matching surface via the control skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. | before | `<this file's directory>/../diagnosing-bugs/SKILL.md` | No failing reproduction exists yet. Then continue Bug fix from the plan step. |
| `<this file's directory>/../poteto-mode/playbooks/feature.md` | 7. If the design is contested, `interrogate` before shipping. | before | `<this file's directory>/../no-comments/SKILL.md` | Review completed code before code-review. |
| `<this file's directory>/../poteto-mode/playbooks/feature.md` | 7. If the design is contested, `interrogate` before shipping. | before | `<this file's directory>/../code-review/SKILL.md` | After no-comments. Keep standards and spec findings separate. |
| `<this file's directory>/../poteto-mode/playbooks/bug-fix.md` | 6. Run **Opening a PR**. | before | `<this file's directory>/../no-comments/SKILL.md` | Review completed code before code-review. |
| `<this file's directory>/../poteto-mode/playbooks/bug-fix.md` | 6. Run **Opening a PR**. | before | `<this file's directory>/../code-review/SKILL.md` | After no-comments. Keep standards and spec findings separate. |
| `<this file's directory>/../poteto-mode/playbooks/opening-a-pr.md` | **Forge.** | before | `<this file's directory>/../poteto-mode/SKILL.md` | Read Pull requests in the host capabilities when opening a PR and before handback. Follow its host integration after creation. |
| `<this file's directory>/../poteto-mode/playbooks/authoring-a-skill.md` | 1. Use the skill-authoring procedure (**Author a skill** in the host capabilities). | before | `<this file's directory>/../writing-for-agents/SKILL.md` | Author or modify agent-facing instructions. |

## Seams and context

A tdd test seam is not a module boundary. Architect owns module boundaries, and tdd confirms the test seam within them.

Keep context focused on the selected route. Read its dependencies when their trigger applies, rather than loading every linked skill. Before handing work off or compacting, save decisions, evidence paths, and unresolved questions in durable notes.
