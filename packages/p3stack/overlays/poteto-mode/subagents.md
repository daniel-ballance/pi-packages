## Subagents

Run the playbook in the chat that received it. Delegate units within a step per [Delegate](references/host-capabilities.md#delegate). If a routed skill needs its own fan-out, check [Nesting](references/host-capabilities.md#nesting) before assigning it to a child.

Choose the role, not a model tweak. Use the code playbook's role (`feature, refactoring`, `bug-fix`, `perf-issue` or `hillclimb`), `hardest tasks` for the hardest changes, `judgment and prose` for judgment or writing, and `swarm workers` for verification. For a routed skill use its named roles. Use the selection `p3stack_roles` returns per [Models and role defaults](references/host-capabilities.md#models-and-role-defaults).

With p3stack on, prepare the brief per your host's [Delegate](references/host-capabilities.md#delegate). Supply the goal, interfaces, owned files, constraints, done check and expected evidence. Pass file pointers per your host's [Store](references/host-capabilities.md#store). Without the header, state the grant and stance in the brief yourself.

Start a fresh child for each new round. Include amended scope, prior evidence and the branch; reuse a worker only for live state the new task needs, such as uncommitted work or a running process. Use a fresh reviewer for a recheck. Verify the diff or evidence yourself and report your conclusion.
