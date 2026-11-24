# About p3stack

p3stack is one of the [six packages in the root install](../README.md#included-resources). Its workflows use two nested components: subagents and todo. You can also [install p3stack alone](../packages/p3stack/README.md#install-choices-and-setup), without a subscription provider.

## What ships

The [source manifest](../packages/p3stack/rules/manifest.json) maps five source names to four upstream checkouts. Two names share the Cursor checkout. Cursor, Matt Pocock, and Addy Osmani supply skills. Superpowers is [watch only](adr/0005-vendor-narrowly-or-watch-only.md). p3stack also supplies its own skills and router.

Git submodule entries pin the upstream commits. The [package README](../packages/p3stack/README.md#license-and-upstreams) mirrors them. The [skill registry](../packages/p3stack/registry/skills.json) records each emitted name or drop reason. For example, Pocock's `tdd` keeps its name and pstack's emits as `regression-test`. Edit the [generator inputs](../packages/p3stack/AGENTS.md), not the generated skills or agent recipes.

## How a request reaches a playbook

With routing on, the extension points Pi to [p3stack-mode](../packages/p3stack/skills/p3stack-mode/SKILL.md). The model selects a [route](../packages/p3stack/registry/routes.json) for the request and grant first. A small, fully specified task is done there and then. For every other route it reads poteto-mode in full, then the route's target. The generator inserts each [chain](../packages/p3stack/registry/chains.json) row into its playbook at the named step, marked **p3stack only**, so the model reads a playbook's added steps in place. A bug without a failing reproduction goes to diagnosis first, which stops at a confirmed cause; the Bug fix playbook then implements once. [House policies](adr/0004-house-policies-win-over-vendored-defaults.md) settle conflicts between skills.

The session branch saves the grant. An explicit request for full autonomy can raise it for one task. Without a grant from the extension, the router uses the default grant. See the [operator commands](../packages/p3stack/README.md#choose-who-decides) to change the saved grant. Turning routing off removes the reminder, not the skills.

While the mode is on, the [brief hook](../packages/p3stack/extensions/p3stack/src/brief.ts) adds the **saved** grant to a parent's spawn or delegate call. It prefixes a new text brief with the writer contract or the read-only review stance. It does not intercept workflow workers or children of children.

## What depends on the host

Terminal Pi uses the subagents Manager. T3 Code supplies its own delegation and scheduling. The [host map](../packages/p3stack/extra/skills/poteto-mode/references/host-capabilities.md) names the operations and gaps on each host. The host and authored lints check for known strings and patterns. Neither proves the tools work.

`p3stack_roles` resolves child model defaults against the available catalog. Interactive terminal setup writes the personal `p3stack.json`. A trusted project can supply `.pi/p3stack.json`. Under T3, use `/skill:setup-pstack` instead. Setup does nothing without a UI.

The static T3 check uses [the recorded contract](../packages/p3stack/rules/t3-pin.json) without inspecting a running host. The recorded version and hash are provenance, not acceptance criteria. Under T3, [doctor](../packages/p3stack/docs/landing/t3-settings.md) records tool inventory. Verify the behavior you rely on in a fresh T3 thread.

## How to verify a change

Use the [eval guide and decision log](evals/README.md) for description checks, live routing probes, and behavior comparisons. The [maintenance procedure](../packages/p3stack/authored/skills/maintain-p3stack/SKILL.md) covers audits and explicit upstream bumps. Write one [bump note](../packages/p3stack/docs/bumps/README.md) per source-update PR.

## Why install from the root?

Pi installs a Git repository, not a subdirectory. The root manifest loads the resources of its six packages in one install. [`scripts/root-package.mjs`](../scripts/root-package.mjs) generates that list from `piBundle` and each member's manifest. The root check detects drift.

For a child that uses claude-subscription, `loaded:claude-subscription` selects the extension file its parent loaded. The same child policy works for Git and checkout installs. The root keeps native MCP. The separate [mcp-client package](../packages/mcp-client/README.md) replaces it and changes authentication, management, and timeout behavior.
