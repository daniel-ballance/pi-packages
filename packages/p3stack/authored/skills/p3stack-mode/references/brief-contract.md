# Brief contract

Each brief stands alone. Keep durable acceptance criteria in the tracker ticket. At dispatch, put the current signatures, checkout-relative paths and done command in the brief. Include the relevant contract, not the parent's conversation.

1. **Goal and scope:** the user's outcome, this unit's part, what it may change.
2. **Interfaces:** exact names and signatures consumed and produced, with their locations at the assigned base.
3. **Constraints:** quote the applicable version floors, naming rules and other global limits verbatim.
4. **Review focus:** name the implied inputs and failure modes the planned tests miss.
5. **Done:** give the command, expected result and surface to check.
6. **Report:** specify the deliverable and return channel. Ask for status, base/head, test evidence, assumptions and unresolved concerns.

The brief header defaults to the session grant. For a different grant, the parent writes `Task grant: <grant>` per the host's Delegate instructions; that grant can be higher or lower. A child never raises its own grant. Operator gates hold under either grant; pause before irreversible actions.

In a terminal the writer's header points to the agent recipe and this contract. Give a report-only child the artifact and contract, not an implementation assignment. Under T3 Code, inline what the child needs or cite the commit and repo-relative path. Give an absolute path only into the run store and only to a child on this machine; otherwise collect evidence in the task result.

**Shared machine.** When children share a machine, the brief says: scratch goes in the child's own subfolder, and the child deletes only that subfolder, never a shared root, lock or another run's files; tests never run under an exported `GIT_DIR`, as from `git rebase -x` or `git bisect run`, because fixtures that run Git then act on the shared repository; each command's own exit code is read, not a pipe's; and heavy runs go through the project's limiter, if it has one.

A child handles only this unit. State assumptions where the brief is silent; stop if an assumption would expand authority. The parent reviews the result against the brief using the [review stance](../p3stack-mode/references/review-stance.md); the worker does not start a reviewer.
