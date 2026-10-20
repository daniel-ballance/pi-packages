# About p3stack

p3stack gives Pi one install identity for its engineering workflows and runtime extensions. Consolidation changes resource discovery, not the six components' internal designs. Keeping each component's tests makes a path move cheaper to verify than a code merge.

## The registry decides what ships

[`registry/skills.json`](../packages/p3stack/registry/skills.json) records each source skill's emitted name or drop reason. The source pins live under [`rules/`](../packages/p3stack/rules/). The generator translates the two vendored upstreams and adds the Pi-owned files from `extra/` and `authored/`.

[`check-registry.mjs`](../packages/p3stack/generator/check-registry.mjs) rejects unclassified skills, duplicate emitted names, missing route or chain targets, and changed chain anchors. Load-time filters do not decide which upstream skill wins. Pocock's `tdd` keeps its name, while pstack's version emits as `regression-test`.

The committed `skills/` tree is generated output. A correction belongs in a rule, overlay, patch, registry row, or authored source, followed by regeneration. The check rejects hand edits.

## The router chooses the procedure

`/p3stack on` makes the mode extension point the model at [`p3stack-mode`](../packages/p3stack/skills/p3stack-mode/SKILL.md). That skill reads poteto-mode and applies p3stack's route and chain tables. The route chooses the first workflow for a request. A chain adds required steps inside a workflow.

[`registry/routes.json`](../packages/p3stack/registry/routes.json) and [`registry/chains.json`](../packages/p3stack/registry/chains.json) are the source tables. The generator renders their references and the router. The routing eval checks the model's first reads on fixture prompts instead of assuming that prompt precedence works.

Disabling the mode removes the router reminder. It does not unload the extensions or remove explicitly invoked skills.

## The host map owns runtime differences

A terminal Pi session uses the subagents extension for children. T3 supplies its own delegation and scheduling. The shared host helper detects T3 from its launch environment, and the host map gives each capability its concrete operation.

[`host-capabilities.md`](../packages/p3stack/extra/skills/poteto-mode/references/host-capabilities.md) is the authored map. Tool names and T3-specific procedure belong there rather than in scattered skills. Role models come from `p3stack_roles` and the `p3stack.json` defaults, not a duplicated static table in the mode prompt.

The T3 pin checker compares the installed contract with [`rules/t3-pin.json`](../packages/p3stack/rules/t3-pin.json). Host lint rejects backend tool names outside the map. A changed nightly contract needs a reviewed map and pin update, not a silent fallback.

## Maintenance keeps source changes reviewable

[`maintain-p3stack`](../packages/p3stack/authored/skills/maintain-p3stack/SKILL.md) starts with a clean tree and green checks on current pins. An audit reports source status without opening a PR. An explicit bump updates a source, reads its upstream scope, repairs rules by failure class, and regenerates the output.

The procedure checks the generated diff, registry, loader, host pin, and routing when route or chain rules changed. Changed-source notes go under [`docs/bumps/`](../packages/p3stack/docs/bumps/README.md). It opens a PR but never merges or updates Pi or T3. Dependency refreshes use the separate repository procedure.

## One package does not mean one MCP client

The p3stack manifest loads its mode extension and the six moved runtime extensions. It includes the p3stack and subagents skill trees. The root manifest has no Pi resources, and the nested component directories are not additional global package entries.

`packages/mcp-client` stays separate. It replaces Pi's MCP implementation to provide protocol features the built-in client cannot expose through public hooks. That replacement also changes management, authentication, and timeout behavior. Enabling it by default would make the packaging change an MCP migration. p3stack therefore keeps native MCP and leaves the replacement an explicit choice.

The [`landing instructions`](../packages/p3stack/docs/landing/t3-settings.md) defer live T3 argument changes and home relinks until the stable checkouts contain the landed stack.
