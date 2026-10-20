---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, use the repo's documented tracker workflow to fetch it and state its title before starting. If no tracker is configured, ask for the ticket text; if the reference is ambiguous, ask.

Read [tdd](../tdd/SKILL.md) where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, read [code-review](../code-review/SKILL.md) to review the work.

Commit your work to the current branch.
