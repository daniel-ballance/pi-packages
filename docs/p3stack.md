# About p3stack

p3stack gives Pi routed engineering workflows and the subagents and todo components they need. The repository root installs it with four standalone packages. Each component keeps its own tests, so a path move is cheaper to verify than a code merge.

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

The default T3 checker validates [`rules/t3-pin.json`](../packages/p3stack/rules/t3-pin.json) and the host map without reading installed state. Its release and bridge hash retain historical provenance, not acceptance criteria. `--installed` reports optional diagnostics; `--doctor <dump>` checks required tools and exposures against a live inventory. The host map also requires review of live schemas and behavior, which doctor cannot prove. Missing capabilities or incompatible behavior blocks maintenance. Host lint rejects backend tool names outside the map.

[`t3-host.md`](../packages/p3stack/docs/t3-host.md) explains how T3 hosts Pi. The `watch` list in [`rules/t3-pin.json`](../packages/p3stack/rules/t3-pin.json) names each T3 contract p3stack depends on. `check-t3-pin.mjs --source <t3 checkout> --ref <tag>` lists the watched T3 files a release changed, and `maintain-p3stack` reviews each one before it moves the reviewed release.

## Maintenance keeps source changes reviewable

[`maintain-p3stack`](../packages/p3stack/authored/skills/maintain-p3stack/SKILL.md) starts with a clean tree and green checks on current pins. An audit reports source status without opening a PR. An explicit bump updates a source, reads its upstream scope, repairs rules by failure class, and regenerates the output.

The procedure checks the generated diff, registry, loader, static host contract, live T3 capabilities and behavior when under T3, and routing when route or chain rules changed. Changed-source notes go under [`docs/bumps/`](../packages/p3stack/docs/bumps/README.md). It opens a PR but never merges or updates Pi or T3. Dependency refreshes use the separate repository procedure.

## The root installs five packages, and mcp-client is not one

Pi 1.3.0 installs a Git source by cloning the whole repository and reading only the root `package.json`. It cannot install a subdirectory. The root manifest therefore loads claude-subscription, p3stack, computer-use, self-reload, and web-search. Each package's own `pi` block stays the source of its resources. `scripts/root-package.mjs` generates the root block from the `piBundle` list, because a hand-written root list would repeat five manifests and drift from them.

p3stack keeps subagents and todo nested, because its workflows need them. The other four packages stand alone. p3stack also installs by itself, and a session without claude-subscription is a valid setup.

subagents asks Pi which claude-subscription file it loaded instead of looking beside itself. A policy entry `loaded:claude-subscription` resolves to the file behind that extension's commands and tools. One `subagents.json` therefore works in a checkout, a Git clone, and a T3 launch, and a child loads the same copy as its parent.

`packages/mcp-client` stays separate. It replaces Pi's MCP implementation to provide protocol features the built-in client cannot expose through public hooks. That replacement also changes management, authentication, and timeout behavior. Enabling it by default would make the packaging change an MCP migration. The root package therefore keeps native MCP and leaves the replacement an explicit choice.

[Configure T3 on each machine](../packages/p3stack/docs/landing/t3-settings.md) gives the T3 launch argument for each install method.
