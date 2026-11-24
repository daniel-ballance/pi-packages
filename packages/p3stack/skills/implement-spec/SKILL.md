---
name: implement-spec
description: "Implement the result of /skill:to-spec and /skill:to-tickets in code."
disable-model-invocation: true
---

For one ticket rather than a spec's task graph, follow [implement](references/implement.md).

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The issue tracker should have been provided to you. If not, tell the user to run `/skill:setup-matt-pocock-skills`.

The goal is the entire spec implemented on a single **integration branch**, with every ticket resolved the way the issue tracker closes work.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Start every subagent with a fresh context window.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency.

## Steps

1. Read the spec and tickets to understand the task graph. Open a ledger for the run per [execution-ledger.md](../p3stack-mode/references/execution-ledger.md), record each dispatch and merge in it, and read it first if this run resumes after compaction.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, accessible by all future subagents. This lets **implementer subagents** focus on implementation rather than exploration.

3. Create the integration branch. If the issue tracker closes work through PRs, or the user asks for one, open a draft PR after the first merge in step 5 (a branch with no commits ahead of main can't open one), marked as closing the spec and tickets. Use [Opening a PR](../poteto-mode/playbooks/opening-a-pr.md) to compose the body, create the integration draft and link it on the active host.

4. Use a fresh **implementer subagent** for each ticket, each in its own worktree on its own branch. At each dispatch, read the current integration tip and use the ticket's acceptance criteria to write the [private brief](../p3stack-mode/references/brief-contract.md) for that base. Each implementer subagent:
   - confirms its worktree is based on the integration branch before starting, and resets onto it if not;
   - reads [tdd](../tdd/SKILL.md) to build the ticket;
   - merges the integration branch tip into its own branch before reporting done

5. Once an **implementer subagent** completes, merge its work to the integration branch with a **merger subagent**.

6. If this changes the **frontier** of available tickets, kick off more **implementer subagents** to work on the new tickets. This allows for maximum concurrency.

7. Once all tickets are complete, read [code-review](../code-review/SKILL.md) on the integration branch. Fix all issues raised by the code review in a single fresh **implementer subagent**.

8. Refresh the integration PR body if one exists. For a requested draft handoff, leave it draft. Otherwise, once the final integration head passes verification and review, mark the same PR ready through Opening a PR. Without a PR, resolve each ticket the way the issue tracker closes work, and report the integration branch.

9. Clean up all **implementer subagent** worktrees.
