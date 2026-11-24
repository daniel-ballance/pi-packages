### Bug fix

**You own this task. Plan, review, verify.** Delegate investigation and the fix to subagents, stay in the lead. Resolve each subagent's role per the Subagents section.

Be scientific. Every shipped line traces to runtime evidence. Belt-and-suspenders that "might help" is a hypothesis, not a fix. It does not ship. When evidence refutes a hypothesis, revert what it motivated. The smallest change the evidence justifies ships, nothing more.

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. If it won't reproduce directly, synthesize the trigger, tighten conditions, or instrument until it fires.
2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with a wake loop (**Wake and loop** in the host capabilities). Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out.
3. Plan the fix. If it carries design risk (see Non-negotiables), `architect` first. Delegate implementation to a subagent using your configured bug-fix model (default `grok-4.7-xhigh-fast`) with a specific scope.

> **p3stack only:** [diagnosing-bugs](../diagnosing-bugs/SKILL.md) — After a diagnosis handoff, run its teardown: remove tagged debug logs and throwaway probes, keep the regression test, then rerun the original reproduction on the same surface.

4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
5. Stage the commits so the failing repro lands before the fix in git history. See the [regression-test](../tdd/references/regression-test.md) for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
   This is the canonical **sequence-verifiable-units** principle skill, the failing test first and the fix on top.

> **p3stack only:** [no-comments](../code-review/references/no-comments.md) — When the code is complete, clean up comments before the floor scan.

> **p3stack only:** [floor](../p3stack-mode/references/floor.md) — Commit any cleanup edits and rerun affected checks. Run floor-check on the final diff; explain or remove every finding.

> **p3stack only:** [review-stance](../p3stack-mode/references/review-stance.md) — Give it to every reviewer, with the artifact and its contract.

> **p3stack only:** [code-review](../code-review/SKILL.md) — Review the floor-checked diff against the request and brief. Record the separate Standards and Spec verdicts at that base and head.

6. Run **Opening a PR**.

**Reply:** what was broken, root cause, fix, how you verified. Paste failing-then-passing repro output verbatim.
