---
name: p3stack-mode
description: Route requests through the p3stack registry and poteto-mode workflows.
disable-model-invocation: true
---

# p3stack mode

Choose the route by deliverable and grant before using tools. Follow the small-task row here: no poteto-mode read or playbook. On every other route, read `poteto-mode/SKILL.md` in full, then the selected target, before any other tool call. This router wins where their rules differ.

Resolve Read paths from the skills directory (the one containing `p3stack-mode/`). For example, if this file is `<package>/skills/p3stack-mode/SKILL.md`, read poteto-mode at `<package>/skills/poteto-mode/SKILL.md`.

## Grants

Use the session grant in the system prompt (`Grant: default` or `Grant: full-autonomy`); if absent, use `default`. An explicit request for full autonomy in the user's message raises it for this task only. Write `Task grant: full-autonomy` in each delegation brief for that task: its header shows the session grant.

Match `any` or the effective grant. Under full autonomy, replace design interviews (grill-with-docs and grilling) with sharpen, then architect. Infer covered choices from repository evidence and report them. Under default, use the interview skills for product choices. Explicit operator gates and irreversible actions still pause.

## House policies

These settle conflicts between the routed skills, and they win over any of them.

1. **Deliverable.** The request names what to deliver. Review and explain: a report. Design: a recommendation. Prototype: a checked demo. Plan: a plan. Stop there; do not edit the code under review, implement, publish, or land. Implementing, opening a PR, babysitting it and landing it each need a separate request or a delivery step of the playbook the request selected.
2. **Authority.** Internal team actions (team chat, ticket updates, starting evals) proceed. Messages to customers or anyone outside the team, deploys, force-pushes to shared branches, and data deletion pause. Under full autonomy, a call only the operator can make gets a default, a report, and a plain statement of what they could choose instead.
3. **Questions.** Before asking the human, sort the question. A fact: look it up or delegate the lookup. Observable by running something: the Prototype playbook, judged by you. Easier to show than to describe: the Prototype playbook, with an interactive-prototype the human tries. A preference no experiment settles: ask. Grilling sorts every question the same way, opens with one open question about why the change is wanted, with no suggested answers, and stops when the frontier is empty or your written hypothesis reaches about 95% confidence.
4. **Validation.** Validate at trust boundaries and before dangerous side effects. Inside them, trust the types.
5. **Migration.** With external consumers, persisted data, or staged deploys, sequence expand–contract. When every caller is internal and in this repository, migrate and delete in one wave.
6. **Testing.** Red before green at the seams architect agreed. regression-test covers cheap bug paths. When the only available test would couple to the implementation, write none and say so in the report. Prototypes and spikes take no tests.
7. **Review independence.** Give a reviewer or judge the artifact and its contract, never the author's conclusion. Every finding names its evidence. A spec's silence is not permission for ordinary inputs to break the program. Dispute a wrong finding with evidence and record the dispute, rather than churning code to satisfy it.
8. **Context.** Give new work to a fresh child with the original goal, the brief, and the prior report. Resume a child only to reuse live state: uncommitted changes or a running process.
9. **Style.** unslop governs replies and PR bodies. Where one of its punctuation rules makes a sentence worse, follow technical-writing and fix the sentence another way.

## Routes

Playbooks carry p3stack's added steps inline; read each marked link when its condition holds.

On a bug-fix request without a failing reproduction, stop diagnosing-bugs at a reproduced failure and confirmed cause, before its fix and cleanup. Implement once, starting at step 3 (plan and delegate the fix) of `poteto-mode/playbooks/bug-fix.md`.

| Request | Grant | Read or do |
| --- | --- | --- |
| Small task: the exact edit in a named file, or one fact answered by reading one function | any | Use the normal route for an unclear cause, more than one file, new behavior, or any risk. Otherwise inspect, edit only if asked, run the nearest existing check, and reply. |
| Understand an existing subsystem | any | `poteto-mode/playbooks/investigation.md` |
| Find a fact outside the repository | any | `research/SKILL.md` |
| Align on a design with the human present | default | `grill-with-docs/SKILL.md` |
| Align on a design without blocking | full-autonomy | `sharpen/SKILL.md` |
| Explore design alternatives | full-autonomy | `architect/SKILL.md` |
| Map a large effort with unresolved decisions | default | `wayfinder/SKILL.md` |
| Publish a tracker spec | default | `to-spec/SKILL.md` |
| Split a spec into tracker tickets | default | `to-tickets/SKILL.md` |
| Plan a program of PRs | any | `poteto-mode/playbooks/multi-phase-plan.md` |
| Execute an approved multi-PR plan with authority to merge | any | `poteto-mode/playbooks/autopilot-full.md` |
| Execute an approved multi-PR plan through verification; the operator lands the PRs | any | `poteto-mode/playbooks/autopilot-stack.md` |
| Prototype a design to compare, try, or show someone | any | `poteto-mode/playbooks/prototype.md` |
| Match an existing UI pixel for pixel | any | `poteto-mode/playbooks/visual-parity.md` |
| Build new or changed behavior | any | `poteto-mode/playbooks/feature.md` |
| Fix a reported bug without a failing reproduction | any | `diagnosing-bugs/SKILL.md` |
| Fix a bug with a failing reproduction | any | `poteto-mode/playbooks/bug-fix.md` |
| Diagnose a recorded trace, profile, or heap snapshot | any | `poteto-mode/playbooks/trace-forensics.md` |
| Diagnose a running process by capturing a live profile or trace | any | `poteto-mode/playbooks/runtime-forensics.md` |
| Investigate measured slowness when a timing or throughput number is given | any | `poteto-mode/playbooks/perf-issue.md` |
| Improve one measured metric repeatedly | any | `poteto-mode/playbooks/hillclimb.md` |
| Restructure code without changing behavior | any | `poteto-mode/playbooks/refactoring.md` |
| Review my change | any | `p3stack-mode/playbooks/review-local.md` |
| Clean up comments in a change | any | `no-comments/SKILL.md` |
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
| Run one job until a checkable condition holds | any | `poteto-mode/playbooks/autonomous-run.md` |
| Run a standing program of PRs | any | `poteto-mode/playbooks/orchestrate.md` |
| Hand work to another tool or person | any | `handoff/SKILL.md` |
| Pause the current session | any | `poteto-mode/playbooks/pause-safely.md` |
| Resume an existing session | any | `poteto-mode/playbooks/session-pickup.md` |
| Review the session's environment | any | `retro/SKILL.md` |
| Write or change a skill | any | `poteto-mode/playbooks/authoring-a-skill.md` |
| Prepare steps only a human can perform | any | `wizard/SKILL.md` |
| Audit and clean up stale worktrees or simulator data | any | `poteto-mode/playbooks/worktree-cleanup.md` |
| Evaluate an agent or instruction change in a blinded experiment | any | `poteto-mode/playbooks/eval.md` |
| Cut a release | any | `release/SKILL.md` |
| Onboard to an existing repository | any | `p3stack-mode/playbooks/onboard-brownfield.md` |
| Audit p3stack pins, refresh its upstream sources, or revert a p3stack maintenance PR | any | `maintain-p3stack/SKILL.md` |
| Handle a task with no matching playbook | any | `figure-it-out/SKILL.md` |

## Seams and context

A tdd test seam is not a module boundary. Architect owns module boundaries, and tdd confirms the test seam within them.

Keep context focused on the selected route. Read its dependencies when their trigger applies, rather than loading every linked skill. Before handing work off or compacting, save decisions, evidence paths, and unresolved questions in durable notes. A run that delegates more than one unit keeps a [ledger](references/execution-ledger.md). Delegation briefs follow the [brief contract](references/brief-contract.md), and every reviewer gets the [review stance](references/review-stance.md).
