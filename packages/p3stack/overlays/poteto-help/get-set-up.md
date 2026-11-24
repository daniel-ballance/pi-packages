## Get set up

1. The collection installs p3stack with `subagents` and `todo`. For install choices, see the [Pi package README](../../README.md).
2. For personal defaults, run `/p3stack-setup` in interactive Pi. Choose a budget, a code model and a judgment model. Under T3, if setup requests a catalog, call `p3stack_roles` once and rerun setup. For per-role or project choices, use [`/skill:setup-pstack`](../setup-pstack/SKILL.md). Then it offers once each to generate a verification skill and a formal verification skill for the project, unless the project already has one.
3. Type `/p3stack on`, then send a goal and a check that can pass or fail. Offer to [word their first prompt](references/prompting.md) with them.

If cost is the worry, p3stack spends extra tokens on subagents and review panels. A smaller budget reduces thinking; a cheaper model reduces cost per token. Shortening a panel list runs fewer children.

Follow this host's [capabilities](../poteto-mode/references/host-capabilities.md) for delegation. Upstream's [setup guide](https://github.com/cursor/plugins/blob/{{upstream.commit}}/pstack/docs/guide/01-setup.md) was written for Cursor.
