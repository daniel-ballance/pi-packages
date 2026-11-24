---
name: p3stack-mode
description: Route requests through the p3stack registry and poteto-mode workflows.
disable-model-invocation: true
---

# p3stack mode

Choose the route for the request and grant first. Then read `poteto-mode/SKILL.md` in full, then the selected target, before any other tool call. This router wins where their rules differ.

Resolve Read paths from the skills directory (the one containing `p3stack-mode/`). For example, if this file is `<package>/skills/p3stack-mode/SKILL.md`, read poteto-mode at `<package>/skills/poteto-mode/SKILL.md`.

## Grants

Use the grant the extension states in the system prompt ("Grant: default" or "Grant: full-autonomy"). An explicit request for full autonomy in the user's message raises it for that task. Without the extension's line, infer it from the request. Full autonomy selects full-autonomy rows, not default rows. Under full autonomy, design starts with sharpen, then architect. Replace grill-with-docs and grilling with that sequence. Infer covered choices from repository evidence and report them. Under the default grant, use the interview skills and ask the human about product choices. Explicit operator gates and irreversible actions still pause.

## House policies

These settle conflicts between the routed skills, and they win over any of them.

1. **Authority.** Internal team actions (team chat, ticket updates, starting evals) proceed. Messages to customers or anyone outside the team, deploys, force-pushes to shared branches, and data deletion pause. Under full autonomy, a call only the operator can make gets a default, a report, and a plain statement of what they could choose instead.
2. **Questions.** Before asking the human, sort the question. A fact: look it up or delegate the lookup. Observable by running something: the Prototype playbook, judged by you. Easier to show than to describe: the Prototype playbook, with an interactive-prototype the human tries. A preference no experiment settles: ask. Grilling sorts every question the same way, opens with one open question about why the change is wanted, with no suggested answers, and stops when the frontier is empty or your written hypothesis reaches about 95% confidence.
3. **Validation.** Validate at trust boundaries and before dangerous side effects. Inside them, trust the types.
4. **Migration.** With external consumers, persisted data, or staged deploys, sequence expand–contract. When every caller is internal and in this repository, migrate and delete in one wave.
5. **Testing.** Red before green at the seams architect agreed. regression-test covers cheap bug paths. When the only available test would couple to the implementation, write none and say so in the report. Prototypes and spikes take no tests.
6. **Review independence.** Give a reviewer or judge the artifact and its contract, never the author's conclusion. Every finding names its evidence. A spec's silence is not permission for ordinary inputs to break the program. Dispute a wrong finding with evidence and record the dispute, rather than churning code to satisfy it.
7. **Context.** Give new work to a fresh child with the original goal, the brief, and the prior report. Resume a child only to reuse live state: uncommitted changes or a running process.
8. **Style.** unslop governs replies and PR bodies. Where one of its punctuation rules makes a sentence worse, follow technical-writing and fix the sentence another way.

## Routes

Playbooks carry p3stack's added steps inline; read each marked link when its condition holds. For a bug without a failing reproduction, the first target is `diagnosing-bugs/SKILL.md`; then continue Bug fix. Review my change runs floor-check per `p3stack-mode/references/floor.md` before no-comments.

| Request | Grant | Read |
| --- | --- | --- |
| Understand an existing subsystem | any | `poteto-mode/playbooks/investigation.md` |
| Find a fact outside the repository | any | `research/SKILL.md` |
| Align on a design with the human present | default | `grill-with-docs/SKILL.md` |
| Align on a design without blocking | full-autonomy | `sharpen/SKILL.md` |
| Explore design alternatives | full-autonomy | `architect/SKILL.md` |
| Map a large effort with unresolved decisions | default | `wayfinder/SKILL.md` |
| Publish a tracker spec | default | `to-spec/SKILL.md` |
| Split a spec into tracker tickets | default | `to-tickets/SKILL.md` |
| Plan a program of PRs | any | `poteto-mode/playbooks/multi-phase-plan.md` |
| Prototype a design to compare, try, or show someone | any | `poteto-mode/playbooks/prototype.md` |
| Build new or changed behavior | any | `poteto-mode/playbooks/feature.md` |
| Fix a reported bug | any | `poteto-mode/playbooks/bug-fix.md` |
| Investigate measured slowness when a timing or throughput number is given | any | `poteto-mode/playbooks/perf-issue.md` |
| Improve one measured metric repeatedly | any | `poteto-mode/playbooks/hillclimb.md` |
| Restructure code without changing behavior | any | `poteto-mode/playbooks/refactoring.md` |
| Review my change | any | `no-comments/SKILL.md` |
| Review someone else's PR | any | `dyl-review/SKILL.md` |
| Triage incoming issues or external PRs | any | `triage/SKILL.md` |
| Open a PR | any | `poteto-mode/playbooks/opening-a-pr.md` |
| Drive an existing PR to readiness | any | `poteto-mode/playbooks/babysit.md` |
| Land a verified stack when authorized | any | `poteto-mode/playbooks/shipping.md` |
| Set or audit the project's quality bar | any | `constraints/SKILL.md` |
| Harden or threat-model a change | any | `security-hardening/SKILL.md` |
| Add telemetry, metrics, or alerts | any | `instrumentation/SKILL.md` |
| Survey codebase health | any | `improve-codebase-architecture/SKILL.md` |
| Implement a tracker ticket graph | any | `implement-spec/SKILL.md` |
| Run a standing program of PRs | any | `poteto-mode/playbooks/orchestrate.md` |
| Hand work to another tool or person | any | `handoff/SKILL.md` |
| Pause the current session | any | `poteto-mode/playbooks/pause-safely.md` |
| Resume an existing session | any | `poteto-mode/playbooks/session-pickup.md` |
| Review the session's environment | any | `retro/SKILL.md` |
| Write or change a skill | any | `poteto-mode/playbooks/authoring-a-skill.md` |
| Prepare steps only a human can perform | any | `wizard/SKILL.md` |
| Handle a task with no matching playbook | any | `figure-it-out/SKILL.md` |
| Cut a release | any | `release/SKILL.md` |
| Onboard to an existing repository | any | `p3stack-mode/playbooks/onboard-brownfield.md` |
| Audit p3stack pins, refresh its upstream sources, or revert a p3stack maintenance PR | any | `maintain-p3stack/SKILL.md` |

## Seams and context

A tdd test seam is not a module boundary. Architect owns module boundaries, and tdd confirms the test seam within them.

Keep context focused on the selected route. Read its dependencies when their trigger applies, rather than loading every linked skill. Before handing work off or compacting, save decisions, evidence paths, and unresolved questions in durable notes. A run that delegates more than one unit keeps a [ledger](references/execution-ledger.md). Delegation briefs follow the [brief contract](references/brief-contract.md), and every reviewer gets the [review stance](references/review-stance.md).
