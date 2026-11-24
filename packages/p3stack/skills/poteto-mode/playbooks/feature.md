### Feature

**You own the design. Plan, review, verify.** Delegate implementation. Stay in the lead.

1. `how` over the affected subsystem.
2. `architect` for parallel design exploration when the change carries design risk (see Non-negotiables). Otherwise name the data shape and its organizing structure here and go to step 3.

> **p3stack only:** [tdd](../tdd/SKILL.md) — Use the seams architect named, or name them yourself when step 2 skipped architect. Confirm them with the human under the default grant.

3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.

> **p3stack only:** [source-grounding](../source-grounding/SKILL.md) — If correct use of a framework or library API depends on the installed version, put its cited doc pages in the brief.

> **p3stack only:** [brief-contract](../p3stack-mode/references/brief-contract.md) — When delegating code, write the brief at handoff, not in a tracker ticket.

> **p3stack only:** [execution-ledger](../p3stack-mode/references/execution-ledger.md) — Open a ledger for more than one delegated unit or work that may outlive this context.

4. Delegate code-writing to a subagent using your configured feature model (default `grok-4.7-xhigh-fast`) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain**, a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria). Pick each subagent's reasoning level for the job, per the Subagents section. When the implementation admits multiple valid shapes (error handling, abstraction layer, test structure), delegate via the **arena** skill instead so the runners surface the alternatives and the cross-judge guards the pick. Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved). A subagent forbidden to spawn satisfies this by owning the diff directly with the same review separation. No "standing by" reply that waits on a nested agent. Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
6. Rebase into small, ordered commits. Stack follow-ups.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.

> **p3stack only:** [no-comments](../no-comments/SKILL.md) — When the code is complete, clean up comments before the floor scan.

> **p3stack only:** [floor](../p3stack-mode/references/floor.md) — After comment cleanup, run floor-check on the final diff; explain or remove every finding.

> **p3stack only:** [review-stance](../p3stack-mode/references/review-stance.md) — Give it to every reviewer, judge, or adversary, with the artifact and its contract.

> **p3stack only:** [code-review](../code-review/SKILL.md) — After the floor scan, review the final diff. Keep standards and spec findings separate.

7. If the design is contested, `interrogate` before shipping.
8. Run **Opening a PR**.

Code-coupled work (one feature, one migration) goes to a single owner with the checkpoint inline. That owner fans out internally after the blocking phase. Parent-level fan-out is for slices that produce independent artifacts (audits, cross-subsystem investigations, competing experiments). Rewrite the checkpoint at phase boundaries. Spawn a fresh owner rather than chaining interrupts.

**Reply:** what you built, what you chose and why, the throughput checkpoint, open decisions. Tables for design alternatives.
