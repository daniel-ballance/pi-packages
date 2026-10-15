# Nested Children go through one root Manager

pistack's orchestrate playbook needs coordinator Children that delegate to Children of their own, which the `subagents` package forbade outright. We allowed it as **bounded nesting through the one root Manager**: a Child above the policy's `maxDepth` (default 1, so nothing changes unless a policy opts in) can be given proxied delegation tools whose calls travel over its private, manager-bound pipe to the root Manager. That Manager composes every grandchild from the same Allowlist, records `parentId` and `depth`, and scopes each call to the caller's subtree.

## Considered options

- **Nested Managers** (each coordinator runs its own Manager, loading this extension in the Child): simpler, but below depth 1 it loses everything the root Manager guarantees. Human holds and Halt/Kill from `/subagents`, cost totals, the live cap, the inspector, and orphan cleanup on reload or exit would each stop at the first level, and a policy edit would have to reach every level separately. Rejected.
- **Workflows only** (express sub-coordination as a workflow definition): kept as the recommended alternative for fixed fan-out, but a coordinator that writes the next wave's briefs from the last wave's results is not a fixed DAG.

## Consequences

- One Manager owns the tree, so `maxChildren` is the live cap for all levels together. A separate tree-wide `maxDescendants` field was not added: it would have duplicated `maxChildren`, or changed what that field means.
- Close, abort, halt and kill cascade down a subtree, like T3's `task_cancel`.
- Routine reports from a nested Child go to its own parent, which drains them with `subagent_wait` and `subagent_read`; they are pulled, not pushed, because pushing a report into a Child would look like a new assignment. Human-intervention notices always reach the root, as do reports from a Child whose parent stopped.
- Delegation tools are never always-on, never given to a Child at the deepest level, never given to workflow workers, and the peer, hold, resume, respond and workflow tools stay parent-only.
