# About p3stack

p3stack is one of the [six packages in the root install](../README.md#included-resources). Its workflows use two nested components: subagents and todo. You can also [install p3stack alone](../packages/p3stack/README.md#install-choices-and-setup), without a subscription provider.

## What ships

The [source manifest](../packages/p3stack/rules/manifest.json) maps five source names to four upstream checkouts. Two names share the Cursor checkout. Cursor, Matt Pocock, and Addy Osmani supply skills. Superpowers is [watch only](adr/0005-vendor-narrowly-or-watch-only.md). p3stack also supplies its own skills and router.

Git submodule entries pin the upstream commits. The [package README](../packages/p3stack/README.md#license-and-upstreams) mirrors them. The [skill registry](../packages/p3stack/registry/skills.json) records 46 emitted skills, 43 references and the reason for each drop. For example, `/skill:tdd` invokes Pocock's TDD procedure; for a cheap bug reproduction it points to pstack's [regression-test](../packages/p3stack/skills/tdd/references/regression-test.md). Edit the [generator inputs](../packages/p3stack/AGENTS.md), not the generated skills or agent recipes.

## How a request reaches a playbook

With routing on, the extension points Pi to [p3stack-mode](../packages/p3stack/skills/p3stack-mode/SKILL.md). The model selects a [route](../packages/p3stack/registry/routes.json) for the request and grant first. A small, fully specified task is done there and then. For every other route it reads poteto-mode in full, then the route's target. The generator inserts each [chain](../packages/p3stack/registry/chains.json) row into its playbook at the named step, marked **p3stack only**, so the model reads a playbook's added steps in place. A bug without a failing reproduction goes to diagnosis first, which stops at a confirmed cause; the Bug fix playbook then implements once. [House policies](adr/0004-house-policies-win-over-vendored-defaults.md) settle conflicts between skills.

The session branch saves the grant. An explicit request for full autonomy can raise it for one task. Without a grant from the extension, the router uses the default grant. See the [operator commands](../packages/p3stack/README.md#choose-who-decides) to change the saved grant. Turning routing off stops new reminders. The skills remain available: a direct [`architect`](../packages/p3stack/skills/architect/SKILL.md) design request still ends at the recommendation. Assign it implementation to continue into code.

The [brief hook](adr/0006-mechanical-procedures-become-tools.md) uses the saved grant. For a task-only increase, the parent writes `Task grant: full-autonomy` in the brief.

## What depends on the host

Skills ask for capabilities such as delegation. Read the [shared host map](../packages/p3stack/extra/skills/poteto-mode/references/host-capabilities.md), then only the matching section for [terminal Pi](../packages/p3stack/extra/skills/poteto-mode/references/host-terminal.md) or [T3 Code](../packages/p3stack/extra/skills/poteto-mode/references/host-t3.md). Terminal Pi uses the subagents Manager. Under T3, the native Manager and its skills stay out of the session.

`p3stack_roles` reads the first valid role file: `.pi/p3stack.json` in a trusted project, then `p3stack.json` in Pi's agent directory. It resolves roles against the host's catalog and reports substitutions or missing choices. A failed T3 lookup does not fall back to terminal models. [Interactive setup](../packages/p3stack/README.md#install-choices-and-setup) writes the personal file on either host. Without a UI it writes nothing.

The static T3 check uses [the recorded contract](../packages/p3stack/rules/t3-pin.json), not a running host. For inventory and live behavior checks, see [Verify host compatibility](../packages/p3stack/docs/landing/t3-settings.md#verify-host-compatibility).

## How to verify a change

The offline description lint checks whether the advertised skills' names and descriptions distinguish example prompts. It does not run the router. A graded routing attempt passes only if the first skill and playbook reads succeed in the expected order. The behavior eval checks the deliverable in a fixture, with routing on or off. It reports process evidence separately: calling the expected tool cannot make a broken result pass.

See the [runner contracts](../packages/p3stack/AGENTS.md#evals) and [eval decision log](evals/README.md). For current-pin audits and explicit upstream bumps, use [maintain-p3stack](../packages/p3stack/authored/skills/maintain-p3stack/SKILL.md).

## Why install from the root?

Pi installs a Git repository, not a subdirectory. The root manifest loads the resources of its six packages in one install. [`scripts/root-package.mjs`](../scripts/root-package.mjs) generates that list from `piBundle` and each member's manifest. The root check detects drift.

For a child that uses claude-subscription, `loaded:claude-subscription` selects the extension file its parent loaded. The same child policy works for Git and checkout installs. The root keeps native MCP. The separate [mcp-client package](../packages/mcp-client/README.md) replaces it and changes authentication, management, and timeout behavior.
