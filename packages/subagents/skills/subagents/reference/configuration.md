# Configuring `subagents.json`

This reference describes this package's policy, not Pi's provider registry or global settings. See the [package README](../../README.md) for the complete contract.

## Scope and precedence

The first existing eligible file wins as a **whole-file replacement**:

1. `<parent launch cwd>/.pi/subagents.json`, only when that project is trusted.
2. `<Pi agent directory>/subagents.json`, normally `~/.pi/agent/subagents.json`.
3. The package's built-in defaults.

The Pi agent directory can be customized. Inspect the actual runtime/configuration rather than assuming the default home path. Project policy lookup uses the parent's launch cwd: it does not walk up to find a parent repository's policy. Changing a child's cwd does not select a different policy. Resource availability is rechecked, but editing a policy requires parent reload.

An untrusted project's policy is ignored. A malformed selected file disables new spawning/resumption; it does **not** fall back to a more permissive file. Existing children remain listable/readable/abortable/closable. A policy edit does not silently change a running child's tools.

A project override must restate every capability it needs from the global configuration. Do not describe it as an overlay. If deleting a project policy is authorized, explain that the global or built-in policy underneath it will become effective; deletion is not equivalent to disabling delegation.

## Fields and defaults

| Field | Meaning |
|---|---|
| `version` | Required, currently `1`. |
| `models` | Required array of `{ "id": "provider/model:thinking", "description": "optional guidance" }`. Exact identities, no aliases/fallbacks. |
| `tools` | Allowed tool names; omitted means none. Spawn still chooses an explicit subset. `subagent_*` tools are forbidden, except the seven delegation tools when `maxDepth` is above 1 (see `maxDepth`). |
| `extensions`, `skills`, `promptTemplates`, `themes` | Allowed explicit resource **files**; omitted means none. Extensions also accept the three [managed built-in identifiers](reference/builtins.md). Not packages, globs, or directories. |
| `alwaysExtensions`, `alwaysTools` | Entries from `extensions`/`tools` (same strings) added to every child's composition without a parent selection; omitted means none. An always-loaded extension's tools stay inactive unless also selected or listed in `alwaysTools`. Any unavailable always-on entry disables spawning (see diagnostics). |
| `systemPrompt`, `appendSystemPrompt` | Allow replacing/appending system-prompt text; omitted means false. Omit both spawn arguments to keep Pi's normal prompt behavior. |
| `contextFiles` | Permit normal AGENTS.md/CLAUDE.md discovery; omitted means false. Children may opt out. This is distinct from the system prompt. |
| `workingDirectories` | Allowed roots and descendants; default `["."]`. Real paths are checked. |
| `maxChildren` | Live-process cap, including idle children. `0` disables spawning. `-1` means no cap. A positive integer is the cap, with no maximum of 64. Omitted means 4. Not a cost, token, or tool-execution limit. |
| `peerMessageLimit` | Integer 0–1000; default 0 disables peer messaging. Positive value caps each directional allowance. Also allowlist `peer_send` and explicitly select it in both participating children. Parent must then connect the pair; no implicit links. |

| `providerExtensions` | Optional provider ID → explicit allowlisted extension file; composition must also select that file. Use it for any provider an extension registers (such as `claude-subscription`): Children start with `--no-extensions`, so without it the catalog marks those models `requiresExtension` and a spawn must select the provider's extension itself. |
| `childSettings` | Optional codemode mode/budget overrides and cache-warming suppression; see [built-ins](reference/builtins.md). |
| `mcp` | Optional native MCP server/raw-tool grants and explicit credential inheritance consent; see [built-ins](reference/builtins.md). |
| `maxDepth` | Optional integer 1–4; omitted means 1: Children cannot delegate. Above 1, the `tools` allowlist may include `subagent_catalog`, `subagent_spawn`, `subagent_send`, `subagent_wait`, `subagent_read`, `subagent_close` and `subagent_list`; a parent selects them per Child, never for a Child at the deepest level, and never through `alwaysTools`. `maxChildren` still caps live Children across all levels. `0` disables spawning at every depth and `-1` removes that cap. `maxDepth` still limits depth. |
| `loops` | Optional parent wake loops (`subagent_loop`, `/loop`); omitted means disabled. When present, all four fields are required: `enabled` (boolean), `minIntervalMs` (1000–86400000), `maxIterations` (1–10000) and `maxDurationMs` (60000–604800000). They are ceilings: a loop may ask for fewer ticks or a shorter run, never more, and its interval may not exceed its run's duration. |

Example loop ceilings: `"loops": { "enabled": true, "minIntervalMs": 60000, "maxIterations": 50, "maxDurationMs": 28800000 }` permits one loop at a time, ticking at most once a minute, 50 times, for up to eight hours. Each tick starts a parent turn and so costs model usage.

Unknown policy fields fail validation. There are no `profiles`, per-model tool permissions, routing rules, cost ceilings, benchmark-score fields or automatic escalation settings. Peer-message counts bound exchanges, not token/cost usage; parent-only renewal can grant further exchanges. Descriptions are optional advisory text, not executable policy.

**Relative paths have two different bases:**

- Resource files resolve relative to the selected configuration file's directory. `./providers/local.ts` in `.pi/subagents.json` means `.pi/providers/local.ts`.
- `workingDirectories` resolve relative to the **parent launch cwd**, even in a global policy. `"."` is a portable launch-directory boundary, not the Pi agent directory. Absolute roots and `~/` paths are supported.

Directories must exist; use exact real absolute paths from the catalog in spawn requests. Shell `bash` grants broad machine access despite a restricted starting cwd. Even without bash, this package is not a filesystem sandbox: file tools and trusted extensions can access outside cwd. Prompt instructions and working-directory restrictions do not provide OS-level isolation.

## Complete example policies

These examples are syntactically/schema-valid templates, **not ready-to-run model registrations**. Every `example-*` provider/model identity is deliberately a placeholder. Replace it with an exact locally registered/authenticated Pi identity and a supported thinking level; `off`, `medium`, and `xhigh` are illustrative, not universally supported. Verify the exact supported level in the installed runtime.

Each example is a separate whole policy, not a fragment to merge automatically:

### Global: conservative exploration

[global-readonly.subagents.json](examples/global-readonly.subagents.json)

Suggested destination: `<Pi agent directory>/subagents.json`. Offers one exploration model and read/search tools, no shell/edit/write tools, two live children, and cwd limited to the launch tree. This reduces permitted actions; it is **not** a sandbox or a guarantee that arbitrary trusted code is read-only.

### Trusted project: exploration plus implementation

[project-development.subagents.json](examples/project-development.subagents.json)

Suggested destination: `<project launch cwd>/.pi/subagents.json`. Offers separate exploration and harder-reasoning entries with editing/testing tools. All listed models are permitted to select any listed tool; their descriptions recommend usage, not enforce roles. This example deliberately restates tools and permissions because it replaces the global policy entirely.

To enforce a read/search-only policy, remove write/edit/bash capabilities from the effective policy for **all** children. To isolate execution, use an external OS/container boundary; model descriptions cannot do this.

### Local deployment: custom provider and limited concurrency

[local-provider.subagents.json](examples/local-provider.subagents.json)

Suggested destination: whichever of the above scopes the user intends. Starts with one live child to avoid assuming a local server can sustain concurrency; measure before increasing it. Allows an explicit custom provider extension at `./providers/local-provider.ts`, relative to that chosen policy file. Replace the example resource path with the actual trusted extension file.

The parent must already have the provider/model registered to advertise it. The child must also receive that provider, either through its normal Pi provider configuration or an explicitly allowlisted **and selected** extension. Adding an extension to `extensions` alone does not select/load it for every child; also list it in `alwaysExtensions` to do that. Use the catalog's resolved absolute extension path in the spawn `extensions` array. If the provider is defined in Pi's model configuration instead, omit the unnecessary extension entry.

A quantized model served through a compatible API still needs working tool-call serialization, chat templates and reasoning controls. A successful plain-chat request does not establish agent compatibility. Do not assume an API key is required or not required: follow that provider's registration/authentication behavior in Pi. Do not put credentials in `subagents.json`.

### Disable new delegation at a scope

[disabled.subagents.json](examples/disabled.subagents.json)

An empty `models` array intentionally permits no spawning/resumption. It does not kill existing children; use explicit close for cleanup. This is different from removing the selected policy and revealing defaults underneath.

## Safe setup and verification

1. Inspect existing policies and ask which scope to change. Preserve unrelated fields and permissions; explain the full-file precedence. Before replacing a file, make an authorized backup outside active policy lookup paths.
2. Resolve exact models/thinking levels through Pi's installed registry/provider setup. For a not-yet-allowlisted model, absence from `subagent_catalog` alone says nothing about whether Pi supports it. Configure/register it first if needed; do not guess an identity from marketing names.
3. Adapt a complete example. Confirm all paths exist, selected resources are trusted, and no broader permission was added merely to make a model appear available.
4. Parse as strict JSON (no comments/trailing commas). Check against this field table or the installed `parsePolicy` implementation. Syntax-valid JSON can still violate policy or refer to unavailable ingredients.
5. Warn about live children, then reload that parent. Call `subagent_catalog`; ask the user to inspect `/subagents diagnostics` for omitted items. Expected usable entries must actually appear. Do not silently substitute another model or reasoning level.
6. With authorization, spawn a small no-tools task, wait/read, send a recall follow-up, then close. Separately test any tools/resources the real workload requires in a disposable workspace. Confirm zero live test children afterward. A no-tools test is a denial-path check, not proof of a sandbox.
7. To roll back, restore the approved prior whole file, reload, and recheck the catalog. Other open parents need their own reload.

## Parent skill versus child skills

Installing this package exposes `/skill:subagents` to the parent. It does not make this or other skills automatically available to children. To give a child a task-specific skill, allow its exact `SKILL.md` in `skills` and explicitly select the catalog's resolved path at spawn. The management skill is meant for the parent; allowing it in a child cannot grant recursive management tools.
