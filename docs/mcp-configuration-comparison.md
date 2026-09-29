# MCP configuration format comparison

Inspected 2026-09-29 through Context7 and direct reads of first-party documentation
and GitHub source. GitHub links below track `main`/`dev`, not fixed releases.
Decision: use Claude-style JSON for Pi. Remove the previous input format without
compatibility aliases. This comparison records the evidence for that choice.

## Native application configuration

| Client | Container | Local process | Remote HTTP |
| --- | --- | --- | --- |
| Claude Code | `.mcp.json`, `mcpServers` map | `command` string, `args` array, `env` map; `type: "stdio"` optional | `type: "http"`, `url`, `headers`; `streamable-http` is an alias |
| Codex | `config.toml`, `[mcp_servers.NAME]` | `command` string, `args` array, `env` map; transport inferred | `url`, `http_headers`, optionally `env_http_headers` or `bearer_token_env_var`; transport inferred |
| OpenCode v1 schema | `opencode.json` / `.jsonc`, `mcp` map | `type: "local"`, `command` array including arguments, `environment` map | `type: "remote"`, `url`, `headers` |
| OpenCode v2 schema on `dev` | `mcp.servers` map | Same local shape | Same remote shape |

These share MCP protocol concepts, but are not interchangeable configuration files.

Sources actually read:

- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp): missing
  `type` means stdio, not inferred HTTP; a URL-only entry is invalid. Explicit
  `sse` selects its older HTTP+SSE transport.
- [Codex MCP types](https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs):
  `RawMcpServerConfig` and `McpServerTransportConfig` define command/args/env and
  URL/http_headers variants. The transport enum is untagged.
- [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json):
  top-level `mcp_servers` points to `RawMcpServerConfig`.
- [OpenCode v1 MCP schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/v1/config/mcp.ts)
  and [v1 config container](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/v1/config/config.ts).
- [OpenCode v2 MCP schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config/mcp.ts)
  and [v2 config container](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config.ts).
  v2 also changes enablement to `disabled` and timeout to separate `startup` and
  `request` values. This is source on `dev`, not a claim about every installed release.
- [OpenCode configuration loader](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/config.ts):
  loads named OpenCode JSON/JSONC files and lowers v2 configuration through its
  compatibility layer before validating against v1.

### Equivalent basic stdio examples

Claude Code:

```json
{"mcpServers":{"example":{"command":"npx","args":["-y","example-mcp"],"env":{"MODE":"demo"}}}}
```

Codex native configuration:

```toml
[mcp_servers.example]
command = "npx"
args = ["-y", "example-mcp"]
env = { MODE = "demo" }
```

OpenCode v1:

```json
{"mcp":{"example":{"type":"local","command":["npx","-y","example-mcp"],"environment":{"MODE":"demo"}}}}
```

## Codex plugin JSON is a separate, important case

It would be incorrect to say Codex only understands TOML MCP definitions.

[Native plugin parser](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs):

- Accepts a JSON `mcpServers` wrapper or a bare server map.
- Accepts/removes transport type hints including `stdio`, `http`,
  `streamable_http`, and `streamable-http`, then validates against Codex's native
  server configuration.
- Normalizes certain OAuth camelCase keys, but is not a general guarantee that
  every Claude Code option behaves identically.

[Agent Plugins parser](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/agent_plugin_config.rs):

- Requires a supported `$schema` and a `mcpServers` map.
- Uses explicit `type: "stdio"` or `type: "streamable-http"`.
- Stdio uses `command`, `args`, `env`, optional `cwd`; HTTP uses `url`, `headers`.
- Recognizes but rejects SSE as unsupported by Codex.
- Applies plugin-specific path and header restrictions.

Therefore Claude-style JSON and Codex plugin JSON have substantial overlap,
including the desired `mcpServers` wrapper. That does not make all three clients'
native configuration formats identical.

## Selected format

Use Claude-style `mcpServers` JSON for Pi's `mcp.json`, with `command`/`args`/`env`,
`type` for transport, and `url`/`headers` for HTTP. Support the documented
`streamable-http` alias. Describe it as Claude-style configuration rather than a
universal Claude/Codex/OpenCode format.

Remove this project's existing `servers`/`transport` input format outright,
as requested; do not add legacy compatibility. Pi-only
capability controls remain per-server options; OAuth uses `clientId`, `scope` and
Claude-style `callbackPort` (other clients' OAuth features are not implied). Do not automatically read
or execute other clients' configurations merely because their schemas are known.
