# Brief contract

Write this brief when you hand implementation to a child. Generate it at hand-off, from the spec, ticket, or plan, and keep it in the store or the delegation. Never write it into a tracker ticket: tickets hold durable decisions, and file paths and signatures go stale there.

A brief is ready when the child can write exactly one reasonable thing from each part:

1. **Goal.** The user's goal in their words, and where this task fits in it.
2. **Interfaces.** What the task uses from earlier work, with exact names and signatures, and what it produces for later work. A child sees only its own brief, so this is how it learns its neighbours' names.
3. **Global constraints.** Version floors, naming and copy rules, and limits copied word for word from the spec or `CONSTRAINTS.md`.
4. **Review focus.** The inputs or failure modes the spec implies but no planned test covers, most likely first. The child adds a test for each one it owns.
5. **Done predicate.** The command to run, the output that means it passed, and the surface to check it on.
6. **Report.** The path to write the full report to, in the store. The child returns only its status, commits, a one-line test summary, and concerns.

Pass file pointers, not pasted history. A brief that restates earlier tasks' summaries spends the child's context and yours.

The child does not spawn its own reviewer. You review its diff against this brief, per the `review-stance.md` reference beside this file.
