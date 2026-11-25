---
name: p3stack-mode
description: Route requests through the p3stack registry and poteto-mode workflows.
disable-model-invocation: true
---

# p3stack mode

Choose the row by deliverable and grant before any other tool call. The small-task row needs no poteto-mode read and no playbook. For every other row, your next two tool calls are that row's two reads, in order: poteto-mode in full, then the target. This router wins where their rules differ.

Paths here are relative to this file's directory. If this file is `<package>/skills/p3stack-mode/SKILL.md`, then `../poteto-mode/SKILL.md` is `<package>/skills/poteto-mode/SKILL.md`.

## Grants

Use the session grant in the system prompt (`Grant: default` or `Grant: full-autonomy`); if absent, use `default`. An explicit request for full autonomy in the user's message raises it for this task only. The brief header defaults to the session grant. For a different grant, the parent writes `Task grant: <grant>` per the host's Delegate instructions; that grant can be higher or lower. A child never raises its own grant. Operator gates hold under either grant; pause before irreversible actions.

Match `any` or the effective grant. For a full-autonomy design request, architect rewrites the brief without an interview; stop at the design synthesis and return its recommendation. Infer covered choices from repository evidence and report them. Under default, use [grilling](../grilling/SKILL.md) for product choices and record settled terms and decisions with [domain-modeling](../domain-modeling/SKILL.md).

## House policies

1. **Deliverable.** The request names what to deliver. Review and explain: a report. Design: a recommendation. Prototype: a checked demo. Plan: a plan. Stop there; do not edit the code under review, implement, publish, or land. Implementing, opening a PR, babysitting it and landing it each need a separate request or a delivery step of the playbook the request selected.
2. **Authority.** Internal team actions (team chat, ticket updates, starting evals) proceed. Messages to customers or anyone outside the team, deploys, force-pushes to shared branches, and data deletion pause. Under full autonomy, a call only the operator can make gets a default, a report, and a plain statement of what they could choose instead.
3. **Questions.** Before asking the human, sort the question. A fact: look it up or delegate the lookup. Observable by running something: the Prototype playbook, judged by you. Easier to show than to describe: the Prototype playbook, with an interactive-prototype the human tries. A preference no experiment settles: ask. Grilling sorts every question the same way, opens with one open question about why the change is wanted, with no suggested answers, and stops when the frontier is empty or your written hypothesis reaches about 95% confidence.
4. **Validation.** Validate at trust boundaries and before dangerous side effects. Inside them, trust the types.
5. **Migration.** With external consumers, persisted data, or staged deploys, sequence expand–contract. When every caller is internal and in this repository, migrate and delete in one wave.
6. **Testing.** Red before green at the seams architect agreed. For a cheap bug path, read [regression-test](../tdd/references/regression-test.md). When the only available test would couple to the implementation, write none and say so in the report. Prototypes and spikes take no tests.
7. **Review independence.** Give a reviewer or judge the artifact and its contract, never the author's conclusion. Every finding names its evidence. A spec's silence is not permission for ordinary inputs to break the program. Dispute a wrong finding with evidence and record the dispute, rather than churning code to satisfy it.
8. **Context.** Give new work to a fresh child with the original goal, the brief, and the prior report. Resume a child only to reuse live state: uncommitted changes or a running process.
9. **Style.** For replies and PR bodies, read [unslop](../technical-writing/references/unslop.md). Where one of its punctuation rules makes a sentence worse, follow technical-writing and fix the sentence another way.
10. **Lessons.** Learn a lesson once. When a rule is broken, a finding repeats or a run goes wrong, and the deliverable allows writes, write the lesson down before the run ends, where the next agent reads it: the project's agent instructions or contributing guide for a project rule, and this skill's references for how a run works. Encode an exact rule as poteto-mode's **Encode Lessons in Structure** principle says. A report-only run puts the lesson and its intended destination in its report instead. When the run keeps a ledger, record where each lesson went.

## Routes

Playbooks carry p3stack's added steps inline; read each marked link when its condition holds.

On a bug-fix request without a failing reproduction, stop diagnosing-bugs at a reproduced failure and confirmed cause, before its fix. Hand the original reproduction, cause, debug tag and throwaway probe paths to `../poteto-mode/playbooks/bug-fix.md` at step 3 for the only implementation. Continue through the end of Bug fix, including its Opening a PR delivery step.

| Request | Grant | Read in this order, or do |
| --- | --- | --- |
| Small task: the exact edit in a named file, or one fact answered by reading one function | any | Use the normal route for an unclear cause, more than one file, new behavior, or any risk. Otherwise inspect, edit only if asked, run the nearest existing check, and reply. |
| Understand one existing subsystem or code path | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/investigation.md` |
| Onboard to a repository, or map it as a whole | any | `../poteto-mode/SKILL.md`, then `../p3stack-mode/playbooks/onboard-brownfield.md` |
| Find a fact outside the repository | any | `../poteto-mode/SKILL.md`, then `../research/SKILL.md` |
| Align on a design with the human present | default | `../poteto-mode/SKILL.md`, then `../grilling/SKILL.md` |
| Design without an interview or explore design alternatives | full-autonomy | `../poteto-mode/SKILL.md`, then `../architect/SKILL.md` |
| Map a large effort with unresolved decisions | default | `../poteto-mode/SKILL.md`, then `../wayfinder/SKILL.md` |
| Publish a tracker spec | default | `../poteto-mode/SKILL.md`, then `../to-spec/SKILL.md` |
| Split a spec into tracker tickets | default | `../poteto-mode/SKILL.md`, then `../to-tickets/SKILL.md` |
| Plan a program of PRs | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/multi-phase-plan.md` |
| Execute an approved multi-PR plan with authority to merge | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/autopilot-full.md` |
| Execute an approved multi-PR plan through verification; the operator lands the PRs | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/autopilot-stack.md` |
| Prototype a design to compare, try, or show someone | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/prototype.md` |
| Match an existing UI pixel for pixel | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/visual-parity.md` |
| Build new or changed behavior | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/feature.md` |
| Fix a reported bug without a failing reproduction | any | `../poteto-mode/SKILL.md`, then `../diagnosing-bugs/SKILL.md` |
| Fix a bug with a failing reproduction | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/bug-fix.md` |
| Diagnose a recorded trace, profile, or heap snapshot | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/trace-forensics.md` |
| Diagnose a running process by capturing a live profile or trace | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/runtime-forensics.md` |
| Investigate measured slowness when a timing or throughput number is given | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/perf-issue.md` |
| Improve one measured metric repeatedly | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/hillclimb.md` |
| Restructure code without changing behavior | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/refactoring.md` |
| Review my change | any | `../poteto-mode/SKILL.md`, then `../p3stack-mode/playbooks/review-local.md` |
| Clean up comments in a change | any | `../poteto-mode/SKILL.md`, then `../code-review/references/no-comments.md` |
| Review someone else's PR | any | `../poteto-mode/SKILL.md`, then `../dyl-review/SKILL.md` |
| Triage incoming issues or external PRs | any | `../poteto-mode/SKILL.md`, then `../triage/SKILL.md` |
| Open a PR | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/opening-a-pr.md` |
| Drive an existing PR to readiness | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/babysit.md` |
| Land a verified stack when authorized | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/shipping.md` |
| Set or audit the project's quality bar | any | `../poteto-mode/SKILL.md`, then `../constraints/SKILL.md` |
| Harden or threat-model a change | any | `../poteto-mode/SKILL.md`, then `../security-hardening/SKILL.md` |
| Add telemetry, metrics, or alerts | any | `../poteto-mode/SKILL.md`, then `../instrumentation/SKILL.md` |
| Survey codebase health | any | `../poteto-mode/SKILL.md`, then `../improve-codebase-architecture/SKILL.md` |
| Implement a tracker ticket graph | any | `../poteto-mode/SKILL.md`, then `../implement-spec/SKILL.md` |
| Run one job until a checkable condition holds | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/autonomous-run.md` |
| Run a standing program of PRs | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/orchestrate.md` |
| Hand work to another tool or person | any | `../poteto-mode/SKILL.md`, then `../handoff/SKILL.md` |
| Pause the current session | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/pause-safely.md` |
| Resume an existing session | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/session-pickup.md` |
| Review the session's environment | any | `../poteto-mode/SKILL.md`, then `../retro/SKILL.md` |
| Write or change a skill | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/authoring-a-skill.md` |
| Prepare steps only a human can perform | any | `../poteto-mode/SKILL.md`, then `../wizard/SKILL.md` |
| Audit and clean up stale worktrees or simulator data | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/worktree-cleanup.md` |
| Evaluate an agent or instruction change in a blinded experiment | any | `../poteto-mode/SKILL.md`, then `../poteto-mode/playbooks/eval.md` |
| Cut a release | any | `../poteto-mode/SKILL.md`, then `../release/SKILL.md` |
| Audit p3stack pins, refresh its upstream sources, or revert a p3stack maintenance PR | any | `../poteto-mode/SKILL.md`, then `../maintain-p3stack/SKILL.md` |
| Handle a task with no matching playbook | any | `../poteto-mode/SKILL.md`, then `../figure-it-out/SKILL.md` |

## Seams and context

A tdd test seam is not a module boundary. Architect owns module boundaries, and tdd confirms the test seam within them.

Keep context focused on the selected route. Read its dependencies when their trigger applies, rather than loading every linked skill. Before handing work off or compacting, save decisions, evidence paths, and unresolved questions in durable notes. A run that delegates more than one unit keeps a [ledger](references/execution-ledger.md). For unattended work or a decision trail the user wants to audit, read [show-me-your-work](references/show-me-your-work.md). Delegation briefs follow the [brief contract](references/brief-contract.md), and every reviewer gets the [review stance](references/review-stance.md).
