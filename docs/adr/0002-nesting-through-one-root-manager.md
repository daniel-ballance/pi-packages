# Nested Children go through one root Manager

p3stack's orchestrate playbook needs coordinator Children that can delegate. A Child below the depth limit can receive delegation tools that forward calls to the root Manager. That Manager uses the same Allowlist for every Child and limits calls to the caller's subtree.

With no policy file, the built-in limit is depth 2. In a user policy, an omitted `maxDepth` means depth 1. Adding nesting did not broaden existing user policies.

## Considered options

- **Nested Managers** (each coordinator runs its own Manager, loading this extension in the Child): simpler, but below depth 1 it loses everything the root Manager guarantees. Human holds and Halt/Kill from `/subagents`, cost totals, the live cap, the inspector, and orphan cleanup on reload or exit would each stop at the first level, and a policy edit would have to reach every level separately. Rejected.
- **Workflows only** (express sub-coordination as a workflow definition): kept as the recommended alternative for fixed fan-out, but a coordinator that writes the next wave's briefs from the last wave's results is not a fixed DAG.

## Consequences

- One Manager owns the tree, so `maxChildren` is the live cap for all levels together. A separate tree-wide `maxDescendants` field was not added: it would have duplicated `maxChildren`, or changed what that field means.
- Close, abort, halt and kill cascade down the whole subtree, stopped descendants included, like T3's `task_cancel`. The subtree is fenced from delegating while a cascade runs, and a hold on any ancestor blocks a descendant.
- Routine reports from a nested Child go to its own parent, which drains them with `subagent_wait` and `subagent_read`; they are pulled, not pushed, because pushing a report into a Child would look like a new assignment. Human-intervention notices and input requests always reach the root (only the root can answer a dialog), as do reports from a Child whose parent stopped.
- Delegation tools are never always-on, never given to a Child at the deepest level, never given to workflow workers, and the peer, hold, resume, respond and workflow tools stay parent-only.
