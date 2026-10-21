# mcp-client for Pi

A Pi package connecting MCP servers to native Pi tools, resource access, and user-selected prompts. Requires **Pi 1.3.0+ and Node.js 22+**.

Supports the original **2024-11-05** specification, the **2025-03-26**, **2025-06-18**, and **2025-11-25** revisions, and the distinct **2026-07-28** protocol. This is a practical client implementation, **not a claim of exhaustive specification conformance**. See the [version-by-feature matrix](CONFORMANCE.md) and limitations below.

## Native Pi alignment and migration safety

This is a **replacement MCP client**, not an add-on to native Pi. Registering its
`/mcp` command replaces built-in session MCP handling on current Pi. Native shell
commands such as `pi mcp list` still use the built-in client and are not this
package's validator.

**Choose the configuration format explicitly.** Package mode (the default) uses
milliseconds and `disabled`; native mode uses seconds and `enabled`, preserving
native exposure/per-tool hiding and trusted partial project overrides. Never
remove unsupported restrictions merely to make a file load. Native mode leaves
`mcp.json` unchanged, so unloading the package does not reinterpret converted
units or disabling fields. Package-mode files must be restored to native format
**before** unloading the package. Deferred loading is not hiding.

### Native configuration mode (Pi 1.x)

Place `mcp-client.json` alongside the native `mcp.json` (global agent directory,
or trusted project `.pi/`):

```json
{
  "configurationFormat": "native",
  "serverOptions": {
    "mac-computer-use": { "protocol": "2025-11-25", "elicitation": true }
  },
  "computerUse": {
    "mac-computer-use": {
      "apps": ["com.apple.calculator"],
      "operations": ["get_app_state", "click", "press_key"],
      "persistence": "session"
    }
  }
}
```

The policy only makes matching requests eligible for a **human** approval dialog;
it is not a permission grant. The first matching request offers **Allow for this
session**, **Decline**, or **Cancel**, identifying the app and complete eligible
operation subset. Explicit session consent is held in memory for that app and
connection only. Later requests must pass the same strict validation before
reusing that grant; unknown apps, operations, schemas or risk metadata do not
inherit permission. Reconnect, recovery, reload and branch navigation invalidate
the grant. Nothing is written to disk and permanent scope is never sent.

The installed server asks for elicitation before each operation; returning
`persist: "session"` alone does not make it remember consent. On reuse the client
returns the server's recognized `computer-use-persisted-state` source marker.
The policy checks elicitation requests, not arbitrary tool code: this is not a
per-call sandbox. It never authenticates, changes OS permissions, or bypasses
native app policy. Unrecognized approval requests fail closed instead of falling
back to generic forms. `mcp_status` exposes a bounded safe approval-event history;
missing UI answers are not described as explicit human denials. Use
`/mcp revoke SERVER` to forget client-side consent immediately and cancel pending
approval dialogs for that server; this cannot undo actions already executed.

Native imports use registered servers as the lowest-priority layer, then global
and trusted project files. Transportless overrides preserve connection settings;
an explicit `toolExposure` map replaces the earlier map, as in native Pi. Exact
tool rules precede the first matching wildcard. Unsupported options (including
`autoEnableCodemode`, provider auth, richer OAuth and shell-valued `!commands`)
fail the whole load without executing anything. Native credentials are not
imported. Timeouts are hard deadlines, not progress-reset timers. The optional
`serverOptions` map permits only wire/capability settings, not access-policy
changes. Native input also recognizes `protocol` and `toolLoading` compatibility
fields; `toolLoading` never overrides exposure.

Native mode registers `mcp__server__tool` identities, namespaces, boolean
annotations, full MCP result envelopes for codemode, and native resource names
(`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`). Hidden
tools are omitted and stale definitions cannot execute. Server-list changes and
session changes abort startup and reconcile connections. POSIX stdio cleanup
owns and terminates the process group, including ordinary wrapper grandchildren;
escaped groups remain best-effort.

See the repository [alignment audit](../../docs/mcp-client-alignment/AUDIT.md) and
[implementation status](../../docs/mcp-client-alignment/README.md). We use native
Pi 1.1.0 as the host-integration reference, not as the authority for Current MCP
wire behavior. Isolated RPC smoke tests pass on actual **Pi 1.0.3 and 1.1.0**:
native names, hidden-tool rejection, registered servers, synthetic session-only
approval, resources, error envelopes and codemode images. A separate live Pi/T3
Calculator test subsequently verified **2 + 2 = 4** by fresh accessibility state
and screenshot through the existing signed server, with **one human session
approval and 11 validated consent reuses**. This is bounded integration evidence,
not broad app coverage or full conformance. `mcp-additions` is parked.

## Install

From this repository:

```sh
npm ci --ignore-scripts
node scripts/patch-pi-host-security.mts
cd packages/mcp-client
pi install "$PWD"
```

Use `pi install -l "$PWD"` for project-local installation instead. Restart Pi or use `/reload`. Installing the package does not configure or start any MCP servers by itself.

For a temporary test after installing dependencies:

```sh
pi -e ./extensions/mcp-client/index.ts
```

## Configure

Create `~/.pi/agent/mcp.json` for global servers, or `.pi/mcp.json` in your project.
Use **Claude-style `mcpServers` JSON** (not Codex's native TOML or OpenCode's
`mcp` schema). See the [source comparison](../../docs/mcp-configuration-comparison.md).
Pi does not automatically read other clients' configuration files.

**Breaking format change:** rename the old `servers` key to `mcpServers` and
`transport` to `type`; rename OAuth `redirectPort` to `callbackPort`.
The old input format is rejected, not maintained as an alias.

Example:

```json
{
  "mcpServers": {
    "local": {
      "type": "stdio",
      "command": "/absolute/path/to/mcp-server",
      "args": [],
      "protocol": "auto",
      "env": { "SERVICE_TOKEN": "${SERVICE_TOKEN}" },
      "roots": ["."],
      "elicitation": true
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "protocol": "2026-07-28",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    },
    "old-server": {
      "type": "sse",
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
- `type` defaults to `stdio`; stdio uses a `command` string, optional `args` array and `env` map. Remote entries require `type: "http"` (or its `streamable-http` alias) or `type: "sse"`, plus `url` and optional `headers`. A URL alone does not imply HTTP.
- Capability controls such as `protocol`, `roots`, `toolLoading`, `sampling` and `tasks` are Pi-specific options, not a promise of full cross-client configuration compatibility.
- `protocol` defaults to `auto`. Supported pins are the five dates above.
- `timeout` is a positive deadline in milliseconds, default **60000** (100–3600000). Connection setup (including `initialized` and fallback), catalog pagination, and each MRTR exchange have overall deadlines. MRTR allows at most eight rounds and 32 input requests per round. Cleanup is bounded separately.
- `cwd` is stdio-only, resolved relative to Pi's session working directory. The default is that directory.
- `${ENV_VAR}` and `${ENV_VAR:-default}` expand in stdio command/args/env and HTTP URL/headers; missing variables without a default fail that server's connection. No shell expansion, command substitution, or automatic `.env` loading occurs.
- Child processes inherit the MCP SDK's minimal safe environment plus explicit `env`, **not the complete Pi environment**. Child stderr is discarded so it cannot corrupt the TUI or RPC output.
- `roots` is opt-in. Paths resolve against Pi's session working directory and are sent as file URIs. Omit it to advertise no roots capability; `[]` advertises an empty roots list. **Roots are informational, not a filesystem sandbox.**
- `elicitation` defaults to false. When enabled, form elicitation is advertised only in Pi's TUI/RPC modes. Simple scalar forms offer **Fill in fields**: strings/numbers use native inputs, enums/booleans use selections, and optional fields can be skipped. Both guided and **Provide JSON** paths now require **Send answers / Edit answers / Cancel** review before release; editing re-enters all values, with at most three review rounds. Review shows the complete losslessly escaped response JSON, in 512-character pages (at most 32 pages). Sending is offered only after the final page; oversized responses fail closed. Field errors do not echo entered values; three invalid attempts cancel that entry flow. The complete original schema is validated. Nonsecret complex/reference schemas and titled-single/multi-select enum schemas retain the reviewed JSON path; dedicated guided controls for those enums are not yet implemented. Guided forms are limited to 16 fields and 40 enum choices. Obvious credential/password/write-only schemas and secret-named JSON keys are rejected on either path; detection is heuristic, not a guarantee. Unknown modes fail closed and cancellation is checked after dialogs. Never enter secrets into form elicitation.
- `elicitationUrl` separately enables URL elicitation. Pi displays the URL and requires approval before launching the system browser; non-HTTP(S) URLs and userinfo are refused. OAuth/secret entry happens in the browser, never in form dialogs. The negotiated protocol, not the configured `auto` setting, determines whether a legacy `elicitationId` is required; Current MRTR URL requests do not require it. Consent is not proof of completion of the external interaction. All MCP dialogs share one queue across servers.
- `sampling` defaults to false. Enable it for separately approved, billed completions in TUI/RPC mode. `samplingMaxTokens` caps output (default 4096, range 1–32768). Pi's current model is used; server preferences do not change it. Input and release each require confirmation. No Pi session context or Pi tools are shared.
- `samplingTools` additionally allows server-supplied tool definitions and balanced tool-use/result transcripts in sampling. Pi returns **proposals for the server to execute**; it never executes them or runs another agent loop. Proposed arguments are validated and require release approval. `required` is checked on the generated response; a model that does not provide tool use fails rather than silently violating the request.
- `toolLoading` defaults to `eager` for compatibility. Set `deferred` on large catalogs: tools remain registered but inactive until `mcp_search_tools` activates matches through Pi's native deferred-loading API. There is no search agent or provider-specific loader.
- `tasks` enables the **2026 Tasks extension**. Task handles are persisted in branch-local entries; `mcp_tasks` can inspect, wait, or cancel. Waiting is bounded and uses the same approval handlers for task input. Reload does not resume work automatically. Aborting a wait leaves server work running; use explicit cancellation.
- HTTP/SSE servers may configure `oauth: {}` (optional `clientId`, `scope`, `callbackPort`, default port **36678**). Use `/mcp login SERVER`, then authorize in the browser. Discovery, dynamic registration or a pre-registered public client, PKCE, loopback state validation, and proactive token refresh use the official SDK. Requires HTTPS except on loopback. Do not combine OAuth with an `Authorization` header. Credentials are stored separately under Pi's agent directory in `mcp-auth/` with private files, never in session entries. `/mcp logout SERVER` removes local credentials; it does not revoke them at the authorization server. These commands reload the extension after success.
- Optional `logLevel`: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, or `emergency`. Logs are bounded UI notifications, not model instructions. Enabling logs may display sensitive server data.
- Pi's configured agent directory and branded project configuration directory are respected; the paths above are the defaults.

### Context7 over HTTPS

[Context7's remote setup](https://github.com/upstash/context7#installation) uses
Streamable HTTP, not a local command or the legacy SSE transport:

```json
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": { "Authorization": "Bearer ${CONTEXT7_API_KEY}" },
      "toolLoading": "deferred"
    }
  }
}
```

Set `CONTEXT7_API_KEY` in the environment **before starting Pi**. For unauthenticated
access, omit `headers` entirely rather than sending an empty key; Context7 recommends
an API key for higher rate limits. No `protocol` pin is required. With deferred
loading, search for the Context7 tools using `mcp_search_tools` to activate them.

For browser OAuth instead, use `https://mcp.context7.com/mcp/oauth` with `oauth: {}`
and no Authorization header, then run `/mcp login context7`. See
[Context7's OAuth documentation](https://github.com/upstash/context7/blob/master/docs/howto/oauth.mdx).
OAuth requires user interaction; it is not exercised by the anonymous HTTPS smoke test.

Verification: a live anonymous HTTPS probe discovered `resolve-library-id` and
`query-docs` and completed a real `resolve-library-id` call, negotiating `2026-07-28`.
The deterministic suite separately verifies that the configured API-key header is
forwarded on discovery, listing and tool calls; it uses a fake key and no network.
Live availability and anonymous rate limits are service-dependent, not a CI guarantee.

### Version and transport selection

`auto` probes `server/discover` using the 2026 per-request metadata. For stdio, an old-style error or probe timeout triggers a fresh process and legacy initialization. Recognized modern protocol errors never trigger a legacy downgrade. The probe deadline is at most five seconds.

For HTTP, eligible legacy errors/statuses trigger initialization over the legacy Streamable HTTP transport. Authentication, network and modern protocol errors do not trigger fallback. Explicitly select `type: "sse"` for original HTTP+SSE servers: the client does **not** guess a separate SSE endpoint. If a legacy server reports an ambiguous HTTP method-not-found error, pin its legacy protocol version.

The official SDK supplies legacy Streamable HTTP, HTTP+SSE, and OAuth mechanics. A small byte-bounded stdio transport handles the 2025-03-26 batch requirement; the package also implements the distinct 2026 stateless HTTP transport. Legacy HTTP session expiry triggers fresh initialization for **future operations**, never replay of the failed call. Shutdown attempts session DELETE before closing.

## Use

In package mode, server tools become Pi tools named `mcp_<server>_<tool>_<hash>`. Native mode uses the native identities described above. Names are stable, collision-resistant, and at most 64 characters. Original server names and descriptions remain visible. Existing Pi tools are preserved; server tools cannot replace `bash`, `read`, etc.

In the TUI, a call is one line in the built-in tool style, not the internal hash. The server is the thing and the tool name is the action, both bold: `context7 • query docs /earendil-works/pi How does renderCall work`. A leading `browser` is dropped, so Playwright reads `playwright • navigate https://example.com`. Tools that are not aimed at one server are just the action: `server status`, `tasks`, `search tools pydantic`. The first argument is accent-colored, the rest use the tool-output color, and `limit` or `timeout` is a muted `(limit 5)`. Server-provided titles are not used on this line. Argument previews are bounded; expanding the tool shows labelled arguments, including explicit `false` values and nested objects/arrays. Expanded previews recursively redact obvious secret-named and `writeOnly` fields. Values behind schema references/compositions are conservatively shown as `[schema-protected]`, not expanded. Previews are not a guarantee of secret detection. This is display-only: wire names, model-visible arguments/results, Pi's result preview, images, errors, and result expansion are unchanged. **Known Pi 0.87.1 limitation:** after `/reload`, historical dynamic-tool calls can fall back to Pi's generic renderer, showing hashed names and raw arguments without these preview redactions. New calls use the custom renderer; do not treat display redaction as a security boundary. See the [reload QA finding](../../docs/mcp-ax-ux/QA.md#known-pi-reload-limitation--not-fixed-here).

The model also gets:

- **`mcp_status`** — explicit connection state, active/catalogued tool counts, catalog freshness, rejected definitions, versions, capabilities, server metadata/guidance, subscriptions and health details. Server guidance is labelled as untrusted reference data.
- **`mcp_search_tools`** — search catalogs and activate returned native Pi tools. Exact names and titles rank above incidental description matches. Reports activation changes, total matches, `nextOffset`, and catalog health alongside titles, annotations and icon descriptors (without fetching icon URLs). Use an empty query with a `server` to browse; `offset` pages through matches. Empty results distinguish missing matches, unavailable servers, rejected definitions and discovery failures.
- **`mcp_tasks`** — list locally recorded handles, inspect, wait for, or cancel a negotiated 2026 task. Never repeat the original tool call to resume one.
- **`mcp_resources`** — list resources, list URI templates, or read an exact URI. Listings expose opaque pagination cursors. Links are never fetched automatically.
- **`mcp_complete`** — prompt-argument and resource-template-variable completion, including already supplied argument context.

### Execution feedback and diagnostics

Running server tool calls show an `awaiting result` update after two seconds, then elapsed-time updates every two seconds until completion. Correlated progress retains a bounded, terminal-safe server message labelled `server progress`. These are tool updates, not additional footer rows; they do not imply that a silent server is stalled or that its side effects can be cancelled.

Local argument validation reports the schema constraint and field path without echoing submitted values. It explicitly says the call was rejected before execution. Request failures after entering the call path conservatively report an unknown execution outcome and warn against blindly retrying side-effecting calls; the original bounded server/transport diagnostic remains available as untrusted output. No automatic tool-call replay is introduced.

Configuration diagnostics identify the source file and invalid field paths without quoting configuration values. Administrative command errors identify the action and a safe error category or local usage hint; arbitrary server error messages and credentials are not copied into these notifications. Rejected tool definitions are counted in status with a reason for each exclusion.

### Quiet health status and delayed activity

Uses Pi's native extension status slots; it does not replace the footer. The health slot remains failure-only: healthy servers, disabled servers, and an empty configuration show nothing—not even an extra row when no other extension statuses are present. A separate **transient activity slot** appears only after two seconds for connection setup, catalog refresh, prompt fetching, or an explicit refresh waiting for the agent to finish. It shows the oldest waiting operation, elapsed seconds and a `(+N)` count for concurrent waits. Completion, failure and shutdown clear this slot without clearing health warnings or other extensions' statuses. Fast startup stays silent; TUI and RPC receive the same status updates.

- Yellow: `⚠ MCP · playwright unavailable` when only some servers fail.
- Yellow: `⚠ MCP · playwright needs attention` for connected servers with discovery/subscription failures or rejected tool definitions.
- Red: `× MCP · unavailable` when all enabled servers have failed.
- Red: `× MCP · invalid configuration` when configuration cannot be loaded.

Multiple issues are summarized with a bounded server name and `(+N)` count. Colours follow the current Pi theme. A concise per-server summary is available through `/mcp status`; `/mcp status details` and `mcp_status` expose capabilities and metadata. Catalog `stale` means discovery will be refreshed before use, not that the connection is broken. Details include safe diagnostics and next actions; normal tool-operation errors do not affect connection health. Status reflects observed failures, not background health polling. Recovery clears the indicator silently; shutdown removes only this extension's status. `/mcp refresh` retries tool discovery on connected servers; use `/reload` to reconnect failed servers or reload configuration. No new settings or dependencies are required.

User commands:

```text
/mcp status
/mcp status details
/mcp refresh
/mcp sampling
/mcp login remote
/mcp logout remote
/mcp prompts local
/mcp prompt
/mcp prompt local
/mcp subscribe local
/mcp unsubscribe local
/mcp prompt {"server":"local","name":"review","arguments":{"language":"typescript"}}
/mcp subscribe {"server":"local","uri":"file:///project/notes.txt"}
/mcp unsubscribe {"server":"local","uri":"file:///project/notes.txt"}
```

Administrative status, prompt catalogs, and sampling reports display immediately as native **non-context entries**; they never queue a model message.

`/mcp prompt` guides server/prompt selection and argument entry; `/mcp prompt SERVER` skips server selection. Optional arguments can be skipped, and a review requires **Add reference** before fetching the prompt. `/mcp subscribe [SERVER]` asks for an exact URI and confirmation; `/mcp unsubscribe [SERVER]` lets you choose a recorded subscription and confirm removal. Escape cancels without queuing a reference or changing subscriptions. These flows share the MCP dialog queue, use native dialogs in TUI/RPC, and require a UI; the JSON command forms remain available for scripting and advanced cases. Catalog network requests do not hold the dialog queue.

Prompts are user-selected reference context for your **next message**. Server-supplied user/assistant roles are preserved as data; they do not impersonate Pi's user or alter its system prompt. Prompt selection does not start a model turn.

`/mcp refresh` refreshes connected servers' tool catalogs after the agent is idle and displays a per-server outcome: refreshed/changed, failed, or unavailable (requiring `/reload`). A failure on one server does not prevent refresh of the others. Subscription retries are requests, not confirmation that a stream has been acknowledged. Tool-list notifications mark discovery dirty. Modern TTL hints are honored before agent turns (missing/zero TTL means stale); catalogs never cross connection/client-identity boundaries. Unchanged definitions are not re-registered. Prompt/resource-list notifications notify the UI without reading or injecting content. Removed tools are disabled and cannot execute through stale registrations. Pi does not expose an unregister-tool API, so disabled definitions can remain visible in its complete registry until reload.

`/mcp sampling` shows sampling usage recorded on the current session branch, including generations whose release was declined. Usage is stored in non-context custom entries and is **separate from Pi's footer totals**: legacy server-initiated requests cannot always be attributed to one of several concurrent Pi tool calls without guessing. No prompt text, generated reasoning or credentials are stored in those usage entries.

Use **`/reload`** to reload configuration, reconnect failed servers and renew subscriptions. User subscriptions are persisted on the current branch and restored only for the same server configuration, working directory, and authorization identity. OAuth refresh retains identity; fresh browser authorization starts a new identity to prevent cross-account restoration. Missing/refused acknowledgments and graceful stream closure affect health; `/mcp refresh` retries failed subscriptions. Disconnections do not automatically retry tool calls: replaying a side-effecting operation could execute it twice. Subscriptions notify the UI without autonomously reading resources or starting agent turns.

## Coverage and Pi mapping

| Feature                                               | Mapping / support                                                                                                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy initialize / initialized / version negotiation | All four legacy versions above; stdio, Streamable HTTP, original HTTP+SSE                                                                                                         |
| 2026 discovery and request metadata                   | `server/discover`; per-request version, client info, capabilities and optional log level                                                                                          |
| 2026 HTTP                                             | POST-only JSON and request-scoped SSE; no protocol sessions, standalone GET stream or response POSTs                                                                              |
| 2026 required HTTP headers                            | `Mcp-Method`, `Mcp-Name`, nested `x-mcp-header` extraction, sentinel Base64 encoding, safe-integer checks; invalid annotated tools excluded                                       |
| Tools                                                 | Native registration and optional deferred activation; original JSON Schema validation including root refs/compositions; structured output validation; bounded paginated discovery |
| Content                                               | Ordered text/images (including prompts), textual resources, links and deduplicated structured JSON; full raw result preserved in details or an artifact                           |
| Tool errors                                           | MCP `isError` becomes Pi `isError` through `tool_result`, preserving error content                                                                                                |
| Resources and templates                               | List, paginate, read; no automatic URI dereferencing                                                                                                                              |
| Prompts and completions                               | User-selected prompts; prompt/resource argument completions                                                                                                                       |
| Progress and cancellation                             | Correlated Pi tool updates, request deadlines, abort signals; stdio cancel notifications / 2026 HTTP stream abort                                                                 |
| Roots                                                 | Explicit configured roots; legacy requests and 2026 MRTR                                                                                                                          |
| Elicitation                                           | Separately opt-in form and URL modes, shared Pi dialog queue; legacy requests and 2026 MRTR                                                                                       |
| Sampling                                              | Doubly approved native model-registry completion; optional server-tool proposals; token caps and persisted usage; legacy and MRTR                                                 |
| OAuth                                                 | Opt-in browser authorization, PKCE/state, discovery/registration, private token persistence and proactive refresh                                                                 |
| 2026 Tasks                                            | Negotiated task handles, explicit polling/cancellation, persisted IDs and input deduplication; no background agent                                                                |
| 2026 MRTR                                             | Fresh request IDs; isolated opaque request state and matching input responses; bounded rounds                                                                                     |
| Notifications/subscriptions                           | Legacy resource subscription and tool-list changes; 2026 filtered `subscriptions/listen`, acknowledgment and subscription-ID correlation                                          |
| Logging                                               | Legacy `logging/setLevel`; 2026 per-request log level; bounded UI-only display                                                                                                    |
| Lifecycle                                             | No processes/sockets in the extension factory; session startup and idempotent shutdown/reload cleanup                                                                             |

### Limits and deliberately unimplemented features

- **Sampling remains independent completions.** No session-context sharing, assistant-image/audio input, model switching, reasoning release or recursive agent execution. Input is capped at 50 KiB. Text-only stop sequences are applied after generation; they do not stop billing early. Declining release does not undo generation charges.
- **OAuth is public-client browser authorization, not every grant/vendor scheme.** No device/client-credentials grants, confidential-client secrets, or headless auto-login. Pi's model-provider `/login` is not repurposed. HTTP redirects are refused. A 401 is not automatically replayed; use `/mcp login SERVER` to reauthorize explicitly.
- **MCP Apps and remote Skills installation are not advertised.** Pi's terminal is not a browser/iframe host. Ordinary resource reads remain data, not skill installation or approval to execute supporting files. A compliant Skills host requires provenance, content-bound approvals, integrity checks and read mediation—not merely downloading `SKILL.md`.
- **Audio/unsupported binary** has no native Pi result mapping. It is saved to a private full-result artifact, not dumped into context as Base64 or silently discarded. Images are limited to four and 5 MiB of Base64 per result.
- **Legacy experimental Tasks and arbitrary vendor extensions** are not advertised. Modern Tasks use explicit polling, not task-notification streams; handles survive reload but polling resumes only on request. Input response keys are persisted before delivery to avoid repeating billed sampling after uncertain delivery. A failed input delivery may require cancellation/restarting the task. Unknown result types fail explicitly.
- Server instructions are not injected into Pi's system prompt. Tool annotations are not security permissions; they do not bypass Pi hooks or authorize actions.
- No conditional caching, 2026 stream resumption, automatic header-mismatch retry, or exhaustive conformance guarantee. 2025-03-26 batches are covered on stdio and HTTP JSON/SSE, including grouped server-request replies; other revisions do not enable this compatibility path. See the matrix.
- Schemas that cannot compile locally (including unresolved remote `$ref`) are rejected; schemas are never fetched. Limits: 100 pages, 2000 catalog entries, 10 MiB aggregate catalog data; each schema 128 KiB, 4000 nodes and depth 40. These are resource budgets, not a sandbox for malicious schemas/regular expressions. Use deferred loading to keep large catalogs out of the initial model context.

## Output and security

Textual tool output and execution errors are limited to **2000 lines / 50 KiB**. Large or unsupported results are stored in a private temporary directory with a mode-0600 JSON file. The artifact pointer is placed **first**, so it survives Pi's tool-result compaction preview. Small raw results (including annotations/metadata) are retained in non-context result details. Files are not deleted at session shutdown, so the agent/user can inspect them afterward; normal system temporary-file cleanup applies. Files and Pi session history can contain server output or sensitive data.

Cancellation or timeout of a legacy `tools/call`, `resources/read`, or `prompts/get`
closes that connection: server-initiated approvals have no reliable parent-call
identity and must not outlive the cancelled operation. Other concurrent operations
on that connection also fail; use `/reload` to reconnect, inspect server state,
and never blindly replay a side-effecting call. Current MRTR inputs use the
originating operation's cancellation signal and do not close unrelated work.
Late responses and collected batch replies are suppressed after shutdown.

Tool results with omitted `content` are normalized to an empty array, matching
native Pi's tolerance for structured-only results. Explicit malformed fields are
still rejected. Native mode additionally implements the full codemode result
object contract.

Incoming stdio frames, HTTP JSON bodies (including errors), and individual SSE events are bounded at **10 MiB**, including legacy transports. Long-lived streams are limited per event, not cumulatively. Cancellation is best-effort: it does not undo server-side effects. Servers and their tool descriptions/results remain untrusted input; use only servers you intend to grant tool access to. Project trust protects configuration loading, **not** execution inside a sandbox.

Capabilities are advertised only when their handlers are enabled. TUI/RPC dialogs fail closed when dismissed; print/JSON modes never auto-approve human input. Server failure is isolated from other servers and existing Pi tools.

## Development

```sh
npm ci
npm run check
npm run format:check
npm test
npm pack --dry-run
```

Read-only native file preflight (no connections or writes; excludes runtime registrations):

```sh
npx tsx scripts/native-preflight.ts /path/to/agent/mcp.json
# A second project path requires explicit --trust-project.
node scripts/native-rpc-smoke.mjs /absolute/path/to/pi
```

The RPC smoke uses synthetic servers and simulated fixture consent only, in an
isolated temporary HOME. Never point its test-driver approval logic at live
servers. It does not install or replace the Pi executable.

For an offline manual TUI demo, run `./scripts/tui-demo.sh` from this package (requires the `pi` executable). It uses a temporary agent directory, a deterministic local provider and fixture server—not personal MCP servers or a billed model. Type `slow`, `form` or `fail`; use `/mcp prompt`, `/mcp subscribe` and `/mcp status` to try the guided commands. Add `--tui-mode fullscreen` for fullscreen mode. See [tmux QA notes](../../docs/mcp-ax-ux/QA.md) for the tested scenarios and reproduction commands. The demo script is a repository development fixture, not included in the published package.

Tests use real child processes for each version; official SDK v1 legacy HTTP/SSE and SDK v2 2026 stdio/HTTP servers; a real Pi SDK session/reload without a model call; local OAuth/PKCE fixtures; bounded transport/error probes; and mocked sampling/UI APIs. No live model calls or external server credentials are required. They are interoperability/regression tests, not an official MCP conformance certification.

Specification references:

- [2024-11-05](https://modelcontextprotocol.io/specification/2024-11-05)
- [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [2026-07-28 schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts)
- [2026 transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [2026 multi-round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
