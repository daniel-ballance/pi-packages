# mcp-client for Pi

A Pi package connecting MCP servers to native Pi tools, resource access, and user-selected prompts. Requires **Pi 0.85.1+ and Node.js 22+**.

Supports the original **2024-11-05** specification, the **2025-03-26**, **2025-06-18**, and **2025-11-25** revisions, and the distinct **2026-07-28** protocol. This is a practical client implementation, **not a claim of exhaustive specification conformance**. See the limitations below.

## Install

From this repository:

```sh
cd pi-extensions/mcp-client
npm ci
pi install "$PWD"
```

Use `pi install -l "$PWD"` for project-local installation instead. Restart Pi or use `/reload`. Installing the package does not configure or start any MCP servers by itself.

For a temporary test after installing dependencies:

```sh
pi -e ./index.ts
```

## Configure

Create `~/.pi/agent/mcp.json` for global servers, or `.pi/mcp.json` in your project:

```json
{
  "servers": {
    "local": {
      "transport": "stdio",
      "command": "/absolute/path/to/mcp-server",
      "args": [],
      "protocol": "auto",
      "env": { "SERVICE_TOKEN": "${SERVICE_TOKEN}" },
      "roots": ["."],
      "elicitation": true
    },
    "remote": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "protocol": "2026-07-28",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    },
    "old-server": {
      "transport": "sse",
      "url": "http://127.0.0.1:3001/sse",
      "protocol": "2024-11-05"
    }
  }
}
```

These are placeholders, not installed servers. A stdio command must already be available. Commands execute directly, **not through a shell**.

- Project configuration is read **only when `ctx.isProjectTrusted()` is true**.
- Project entries replace global entries with the same name; they do not partially merge. Set `"disabled": true` to disable an inherited entry.
- Missing files are fine; invalid JSON, unknown fields, or invalid configuration reject the configuration before any server starts.
- `protocol` defaults to `auto`. Supported pins are the five dates above.
- `timeout` is a positive request deadline in milliseconds, default **60000** (100–3600000). MRTR exchanges share one overall deadline and allow at most eight rounds, with at most 32 input requests per round.
- `cwd` is stdio-only, resolved relative to Pi's session working directory. The default is that directory.
- `${ENV_VAR}` expands in stdio command/args/env and HTTP URL/headers; missing variables fail that server's connection. No shell expansion, command substitution, or automatic `.env` loading occurs.
- Child processes inherit the MCP SDK's minimal safe environment plus explicit `env`, **not the complete Pi environment**. Child stderr is discarded so it cannot corrupt the TUI or RPC output.
- `roots` is opt-in. Paths resolve against Pi's session working directory and are sent as file URIs. Omit it to advertise no roots capability; `[]` advertises an empty roots list. **Roots are informational, not a filesystem sandbox.**
- `elicitation` defaults to false. When enabled, form elicitation is advertised only in Pi's TUI/RPC modes. JSON entered through Pi's dialogs is validated against the server's requested schema; decline and cancellation are supported. Never enter secrets into form elicitation.
- `sampling` defaults to false. Enable it to allow separately approved, billed model completions in TUI/RPC mode. `samplingMaxTokens` caps output (default 4096, range 1–32768). Pi's current model is used; server model preferences do not change it. Both the input and release of the generated text require confirmation. No Pi session context or tools are shared.
- Optional `logLevel`: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, or `emergency`. Logs are bounded UI notifications, not model instructions. Enabling logs may display sensitive server data.
- Pi's configured agent directory and branded project configuration directory are respected; the paths above are the defaults.

### Version and transport selection

`auto` probes `server/discover` using the 2026 per-request metadata. For stdio, an old-style error or probe timeout triggers a fresh process and legacy initialization. Recognized modern protocol errors never trigger a legacy downgrade. The probe deadline is at most five seconds.

For HTTP, eligible legacy errors/statuses trigger initialization over the legacy Streamable HTTP transport. Authentication, network and modern protocol errors do not trigger fallback. Explicitly select `transport: "sse"` for original HTTP+SSE servers: the client does **not** guess a separate SSE endpoint. If a legacy server reports an ambiguous HTTP method-not-found error, pin its legacy protocol version.

The official SDK supplies stdio, legacy Streamable HTTP and HTTP+SSE transport mechanics. The package implements a separate 2026 stateless HTTP transport; changing an SDK version constant would not implement this revision.

## Use

Server tools become Pi tools named `mcp_<server>_<tool>_<hash>`. Names are stable, collision-resistant, and at most 64 characters. Original server names and descriptions remain visible. Existing Pi tools are preserved; server tools cannot replace `bash`, `read`, etc.

In the TUI, calls have friendly headers (for example, `Context7 · Query documentation`) and labeled argument previews instead of showing the internal hash. Server-provided titles are preferred, with readable tool names as a fallback. Argument previews are bounded; Ctrl+O also reveals more argument detail. Obvious secret-named and `writeOnly` fields are redacted in these previews (not a guarantee of secret detection). This is display-only: wire names, model-visible arguments/results, Pi's result preview, images, errors, and result expansion are unchanged.

The model also gets:

- **`mcp_status`** — configured server names, negotiated versions and capabilities.
- **`mcp_resources`** — list resources, list URI templates, or read an exact URI. Listings expose opaque pagination cursors. Links are never fetched automatically.
- **`mcp_complete`** — prompt-argument and resource-template-variable completion, including already supplied argument context.

### Failure-only footer status

Uses Pi's native extension status slot; it does not replace the footer. Healthy servers, normal startup, disabled servers, and an empty configuration show nothing—not even an extra row when no other extension statuses are present.

- Yellow: `⚠ MCP · playwright unavailable` when only some servers fail.
- Yellow: `⚠ MCP · playwright needs attention` for connected servers with discovery/subscription failures.
- Red: `× MCP · unavailable` when all enabled servers have failed.
- Red: `× MCP · invalid configuration` when configuration cannot be loaded.

Multiple issues are summarized with a bounded server name and `(+N)` count. Colours follow the current Pi theme. Details are available through `/mcp status` or `mcp_status`; normal tool-operation errors do not affect connection health. Status reflects observed failures, not background health polling. Recovery clears the indicator silently; shutdown removes only this extension's status. `/mcp refresh` retries tool discovery on connected servers; use `/reload` to reconnect failed servers or reload configuration. No new settings or dependencies are required.

User commands:

```text
/mcp status
/mcp refresh
/mcp sampling
/mcp prompts local
/mcp prompt {"server":"local","name":"review","arguments":{"language":"typescript"}}
/mcp subscribe {"server":"local","uri":"file:///project/notes.txt"}
/mcp unsubscribe {"server":"local","uri":"file:///project/notes.txt"}
```

Prompts are user-selected reference context for your **next message**. Server-supplied user/assistant roles are preserved as data; they do not impersonate Pi's user or alter its system prompt. Prompt selection does not start a model turn.

`/mcp refresh` refreshes connected servers' tool catalogs after the agent is idle. Tool-list notifications mark discovery dirty; it refreshes before the next user turn. Removed tools are disabled and cannot execute through stale registrations. Pi does not expose an unregister-tool API, so disabled definitions can remain visible in its complete registry until reload.

`/mcp sampling` shows sampling usage recorded on the current session branch, including generations whose release was declined. Usage is stored in non-context custom entries and is **separate from Pi's footer totals**: legacy server-initiated requests cannot always be attributed to one of several concurrent Pi tool calls without guessing. No prompt text, generated reasoning or credentials are stored in those usage entries.

Use **`/reload`** to reload configuration, reconnect failed servers and renew subscriptions. Disconnections do not automatically retry tool calls: replaying a side-effecting operation could execute it twice. Subscriptions notify the UI without autonomously reading resources or starting agent turns.

## Coverage and Pi mapping

| Feature | Mapping / support |
|---|---|
| Legacy initialize / initialized / version negotiation | All four legacy versions above; stdio, Streamable HTTP, original HTTP+SSE |
| 2026 discovery and request metadata | `server/discover`; per-request version, client info, capabilities and optional log level |
| 2026 HTTP | POST-only JSON and request-scoped SSE; no protocol sessions, standalone GET stream or response POSTs |
| 2026 required HTTP headers | `Mcp-Method`, `Mcp-Name`, nested `x-mcp-header` extraction, sentinel Base64 encoding, safe-integer checks; invalid annotated tools excluded |
| Tools | Native Pi registration; input JSON Schema validation; structured output schema validation; paginated discovery |
| Content | Text, supported Pi images, textual embedded resources, resource-link descriptors and structured JSON |
| Tool errors | MCP `isError` becomes Pi `isError` through `tool_result`, preserving error content |
| Resources and templates | List, paginate, read; no automatic URI dereferencing |
| Prompts and completions | User-selected prompts; prompt/resource argument completions |
| Progress and cancellation | Correlated Pi tool updates, request deadlines, abort signals; stdio cancel notifications / 2026 HTTP stream abort |
| Roots | Explicit configured roots; legacy requests and 2026 MRTR |
| Form elicitation | Opt-in Pi dialogs with JSON Schema validation; legacy requests and 2026 MRTR |
| Sampling | Opt-in, doubly approved completion through Pi's model registry; text and compatible user images; output/token caps and separate persisted usage; legacy requests and 2026 MRTR |
| 2026 MRTR | Fresh request IDs; isolated opaque request state and matching input responses; bounded rounds |
| Notifications/subscriptions | Legacy resource subscription and tool-list changes; 2026 filtered `subscriptions/listen`, acknowledgment and subscription-ID correlation |
| Logging | Legacy `logging/setLevel`; 2026 per-request log level; bounded UI-only display |
| Lifecycle | No processes/sockets in the extension factory; session startup and idempotent shutdown/reload cleanup |

### Limits and deliberately unimplemented features

- **Sampling is intentionally limited to independent completions.** No sampling tools, shared session context, assistant-image input, model switching, provider reasoning output or recursive agent execution. Sampling input is capped at 50 KiB; only generated text is returned. Stop sequences are applied to the completed output locally (they do not stop provider billing early). Closing a confirmation does not undo already billed generation.
- **OAuth discovery/login/refresh is not implemented.** Use explicitly configured headers or an externally managed token. Pi's model-provider `/login` is not repurposed as an MCP authorization manager. Tokens should be scoped to the configured server; avoid HTTP except on trusted loopback networks. Redirects are refused.
- **URL elicitation and MCP Apps/browser UI are not advertised.** There is no hidden browser, automatic URL opening, HTML execution or iframe emulation.
- **Audio/binary rendering** has no direct Pi tool-result mapping. Such blocks are represented as JSON rather than pretending to be playable or silently dropping them. Image emission is limited to four images and 5 MiB of Base64 data per result.
- **Tasks, experimental extensions, cross-server context inclusion, and automatic reconnection/replay** are not implemented. The legacy experimental task feature is not translated into Pi's agent loop. Unknown `resultType` values fail explicitly.
- Server instructions are not injected into Pi's system prompt. Tool annotations are not security permissions; they do not bypass Pi hooks or authorize actions.
- No conditional caching, stream resumption for 2026, automatic retry on header mismatch, or exhaustive batching/conformance guarantee. Legacy stream behavior is delegated to the pinned SDK.
- Schemas that cannot be compiled locally (including unresolved remote `$ref`) are rejected; schemas are never fetched. Discovery is limited to 100 pages. Large catalogs can still consume substantial model context; tools are eagerly registered rather than using a separate search-agent abstraction.

## Output and security

Textual tool output is limited to **2000 lines / 50 KiB**. Larger results are stored in a private temporary directory with a mode-0600 JSON file, and the returned text points to it. Files are not deleted at session shutdown, so the agent/user can inspect them afterward; normal system temporary-file cleanup applies. Files and Pi session history can contain server output or sensitive data.

Stdio frames, HTTP JSON responses and SSE parser buffers are bounded at approximately **10 MiB**. Cancellation is best-effort: it does not undo server-side effects. Servers and their tool descriptions/results remain untrusted input; use only servers you intend to grant tool access to. Project trust protects configuration loading, **not** execution inside a sandbox.

Capabilities are advertised only when their handlers are enabled. TUI/RPC dialogs fail closed when dismissed; print/JSON modes never auto-approve human input. Server failure is isolated from other servers and existing Pi tools.

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

Tests use local fixtures: real child processes for every supported version, official-SDK legacy HTTP and SSE servers, a 2026 HTTP server with fragmented SSE and header checks, and mocked Pi lifecycle/UI APIs. No live model calls or external server credentials are required. They are interoperability/regression tests, not an official MCP conformance certification.

Specification references:

- [2024-11-05](https://modelcontextprotocol.io/specification/2024-11-05)
- [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [2026-07-28 schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts)
- [2026 transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [2026 multi-round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
