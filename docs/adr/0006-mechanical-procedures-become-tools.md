# Mechanical procedures become tools

Use code for steps the model might otherwise skip. While the mode is on, the brief hook intercepts a parent's `subagent_spawn` or `mcp__t3-code__delegate_task` call with a text task. It skips briefs it already prefixed. It adds the saved grant and either the writer contract or the read-only review stance. The shorter read-only brief keeps a reviewer on the assigned question instead of starting a playbook. The hook does not cover workflow workers or children of children.

`floor-check.mjs` checks the diff for quality-floor violations. `p3stack_roles` with `distinctFrom` prefers a different model family when the catalog offers one. Workflow templates let the subagents engine run interrogate, arena, hillclimb, and skill evals. The offline description lint checks vocabulary, not the model's choices.

Prose stays for judgment: the house policies, the references, and the playbooks.

## Considered options

- **More prose in the skills**: rejected. Each rule costs context on every read, and agents under pressure skip it. All four upstreams already say a repeated instruction should become a check.
- **Tools only on one host**: accepted only where the host lacks the primitive. Workflow templates are terminal-only because T3 has no workflow engine; the host map states the gap and the prose procedure remains the fallback (ADR 0001).

## Consequences

Each tool has tests on both hosts where it touches host behavior. A tool's output is still untrusted work output until a check or a review confirms it.
