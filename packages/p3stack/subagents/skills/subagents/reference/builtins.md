# Managed Pi built-ins

This is the policy contract for the native Pi client/executors. See [configuration](reference/configuration.md) for whole-file precedence and path bases. The `mcp-client` package is separate and is not used here.

## Opt in without broadening other grants

Preserve all existing model, tool, resource, directory and prompt permissions. Append `"builtin:codemode"` to the policy's `extensions` and `"codemode"` to its `tools`. At spawn, explicitly select that extension and tool alongside only the tools the child needs. Loading codemode grants no nested tools by itself. For deferred-tool search, additionally append/select `"builtin:tool-search"` and `"tool_search"`.

These are the only supported built-ins, plus `"builtin:mcp"` below. Unknown `builtin:*` values, including `builtin:llama.cpp`, invalidate the policy. File resources still require canonical exact files. Built-ins load through Pi's public factories inside the mandatory guard, not unrestricted ambient clients.

`providerExtensions` optionally maps a provider ID to an allowlisted extension file:

```json
{ "providerExtensions": { "example-provider": "./providers/local.ts" } }
```

`compile` adds that file to the child that uses the mapped provider. The spawn does not have to name it. The model must already be available in the parent. A tool whose source is a different extension still needs that extension selected. The child checks tool provenance at startup and at execution, using `getAllTools()` rather than only active declarations. Deferred tools can be allowed without being declared to the model.

## MCP: server selection is also a permission

Add `"builtin:mcp"` to allowed/selected extensions. Add an explicit policy grant; endpoints, commands and credentials stay in native Pi `mcp.json`, not `subagents.json`:

```json
{
  "mcp": {
    "inheritCredentials": true,
    "servers": [
      { "name": "context7", "tools": ["resolve-library-id", "query-docs"] },
      { "name": "playwright", "tools": ["browser_navigate", "browser_snapshot"] }
    ]
  }
}
```

This is an **optional fragment**, not a replacement policy. Match server names and original tool names to your existing native configuration. The example grants only two tools per server, not every Playwright capability. Exact names and a single trailing `*` prefix pattern are supported; `*` explicitly grants all nonrecursive tools on that server, including future additions. Patterns match **raw MCP tool names**, not sanitized `mcp__...` names. `subagent_*` raw tools are always excluded, even under `*`. Server names whose normalized namespaces collide are rejected.

Spawn/worker composition must select `mcpServers: ["context7"]` (or the needed subset) and select `codemode` or `tool_search` with its matching built-in extension. MCP selections authorize only those servers' granted tools; the ordinary `tools` array still controls non-MCP tools. `tools: []` with no MCP selections disables tools.

Defaults: no selected servers, no credential consent, no project MCP configuration. Unselected global/project/extension-registered servers never connect through this integration. Extension-registered servers, MCP resources and prompts are not supported grants. Native MCP `/mcp` management is suppressed in children; it cannot mutate config/auth or enable other servers.

`inheritCredentials: true` is mandatory for any MCP server selection, including stdio. It explicitly permits native configured headers, environment references, provider tokens and OAuth access/refresh for selected servers. Pi owns credential storage, refresh locking and transports; this package neither copies tokens nor implements OAuth. Credential-free native store isolation is not exposed here: absent/false consent **refuses launch**, not a pretend unauthenticated connection. Configure/sign in outside the child first.

Global `mcp.json` is eligible by default. A server grant's optional `project: true` also admits `<child cwd>/.pi/mcp.json` **only within the parent's trusted project**; same-name project definitions then replace global definitions. Project `auth.provider` remains forbidden. Invalid selected entries fail the child handshake before any selected server connects. Disabled/disconnected servers may have no callable tools; inspect native startup errors in the child's log. Network availability is not guaranteed by a catalog grant.

Native `autoEnableCodemode` is an MCP-config field, not a settings field. It cannot broaden managed children: explicit selection and the guard determine discovery-tool activation.

## Per-child settings without file edits

Optional policy fragment:

```json
{
  "childSettings": {
    "codemode": { "mode": "only", "inlineBudget": 3000 },
    "cacheWarming": "off"
  }
}
```

Codemode `mode` accepts `on` or `only`; `inlineBudget` is a nonnegative safe integer. Native factory options implement those overrides. Omitted values inherit Pi settings. There is no arbitrary settings/env passthrough.

`cacheWarming` accepts only `off`: the child returns `stop` at Pi's warming-decision hook, without writing settings. Omitted means **global** Pi warming behavior is inherited, potentially incurring cost. Project `cacheWarming: "off"` alone does not disable warming. The catalog explains inheritance; the child handshake records relevant effective and enforced settings. These are behavioral overrides, not a rewrite of `getSettings()`.

## Boundaries and verification

- Native codemode's entire `models` namespace is disabled: classifier calls do not emit tool hooks. There is no classifier allowlist field. Virtual/non-chat model selections are rejected; exact startup/resume model identity is checked before sending tasks.
- Nested calls retain Pi's execution pipeline and guard. Search sees only permitted tools, so it cannot repeatedly activate a forbidden tool. MCP authorization uses Pi's original server/tool label mapping, not a lossy sanitized-name reverse mapping; pinned-runtime tests cover collisions.
- This is **not a sandbox**. File tools, shell, stdio servers and trusted extensions run with host-user access. Trusted extension code can call providers/credentials directly, alter models/settings, or perform side effects outside tool hooks. Initial model identity checks are not a general provider-call firewall. Use OS isolation for adversarial code. MCP credential consent does not isolate a server executable's environment/filesystem.
- A source path is provenance, not a content hash or signature. Configuration files and selected extension files remain trusted mutable inputs. Future Pi changes to native metadata/labels require compatibility tests.
- Reported cost comes from cumulative RPC stats, including nested/classifier and persisted warming usage; it is not a provider bill or a spending ceiling. `handled` input is not task success, and unknown acceptance is not safe to replay.

Run `npm run check`, `npm test`, and `PEER_TEST_EXECUTABLE="$(command -v pi)" npm test` in `packages/p3stack/subagents`, plus the root `./scripts/check.sh`. The tests use temporary agent directories, local providers, synthetic costs and a tiny stdio fixture; no live credentials or paid provider calls are needed. Reload the parent after an authorized policy change; inspect catalog/diagnostics before composing a child. Never copy this fragment over a whole existing policy.
