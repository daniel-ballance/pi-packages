### Session pickup

**You own the resume point. Read the prior trail, don't redo it.**

> **p3stack only:** [execution-ledger](../p3stack-mode/references/execution-ledger.md) — Look for the run's ledger in the store first. When it exists, it and git log outrank the transcript.

1. Locate the prior trail. To resume prior work, use this project's [Session history](references/host-capabilities.md#session-history) or a pushed branch. Read the metadata overview and last messages first, then scan back for the decision points. Parse a long transcript in a subagent and keep the reduced timeline in the main thread (the [principle-guard-the-context-window](../poteto-mode/references/principle-guard-the-context-window.md) reference). Resolve each subagent's role per the Subagents section.
2. Reconstruct operational state. The branch and worktree, what already landed (`git log`, `git diff` against the base), the open todos, the decisions made. The prior trail is authoritative input. Resist the bias to re-derive it.
3. Diff done vs pending. Compare what shipped against what was planned, name the resume point, do not re-run the prior repro or redo completed work. A "let me verify from scratch" pass means you're treating the trail as untrustworthy when it's authoritative.
4. Route the remaining work to the matching playbook and pick the verdict: continue the execution, ship a finished recommendation, ratify or override a prior conclusion, or postmortem a failed run. The pickup playbook ends here. The routed playbook owns the rest.
5. Verify the inherited claims against the original goal on the real artifact (the [principle-prove-it-works](../poteto-mode/references/principle-prove-it-works.md) reference). A passing prior self-report is not the proof.

**Reply:** where the prior agent stopped, what you inherited vs redid (ideally nothing redone), the resume point, and the outcome.
