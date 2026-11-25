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

**Shared machine.** When children share a machine, the brief says: the child keeps scratch in its own subfolder and deletes only that subfolder; it reads each command's own exit status; heavy runs go through the project's limiter, if it has one; and tests run where `GIT_DIR` is unset, because fixtures that run Git under an exported `GIT_DIR` (as `git rebase -x` or `git bisect run` can export in a linked worktree) act on the shared repository.

**Dispatch.** Before dispatching a unit, list the files it will likely change and compare them with every open pull request (`gh pr diff N --name-only`). On overlap, hold the unit, or stack it on that pull request; do not let the child discover the overlap. Point the brief at the project's issue that collects known intermittent failures instead of an inline list that grows with each run, and tell the child the project's filing bar.

A child handles only this unit. State assumptions where the brief is silent; stop if an assumption would expand authority. The parent reviews the result against the brief using the [review stance](../p3stack-mode/references/review-stance.md); the worker does not start a reviewer.
