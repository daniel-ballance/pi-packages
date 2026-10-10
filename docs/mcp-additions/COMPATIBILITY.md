# MCP additions: compatibility and first scope

## Evidence boundary

Research date: **2026-10-08 (UTC)**. This is a source review, not an interoperability certification or a shipped package support promise.

- Read repository `AGENTS.md` and `README.md`. Existing `mcp-client` documentation is **not** evidence for protocol or native Pi compatibility.
- Native baseline: [earendil-works/pi v1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0), resolved with `git ls-remote` to **`abe508e1b89912adde45528136c3221eb69acdd7`** (commit timestamp 2026-10-07T21:33:33Z). The pinned [`coding-agent/package.json`](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/package.json) says `1.1.0`.
- All 33 TypeScript snapshots under `/tmp/pi-1.1.0-mcp-review` were compared byte-for-byte with direct raw GitHub responses at that commit; all matched. Native findings below concern that release, not this research session's installed Pi.
- MCP evidence was fetched directly from official `modelcontextprotocol.io` Markdown pages, not search snippets. The official repository's `main` resolved during research to **`c518f7a927cff918bce35d3522fcdb046d264d7c`** (2026-10-08T12:57:38Z). Its [pinned navigation/redirect configuration][mcp-navigation] independently identifies `2026-07-28` as latest. This records a repository revision, not a claim that every live website response is byte-identical to that commit.
- Only this document was intentionally written. No installs, configuration changes, live-server exercises, or desktop/Mac interaction were performed.

## Decision in brief

Build **optional additions to native Pi**, not a second MCP client. Preserve native configuration, trust, authentication, transports, connections, tool exposure, resources, and `/mcp` ownership. Retire each addition when native Pi provides equivalent behavior.

**First engineering scope: secure a supported native connection/capability hook, then implement opt-in form elicitation on that connection.** URL elicitation is a separate follow-up with stricter browser isolation requirements. Do not start with sampling, expanded roots, legacy SSE, or a new protocol stack.

There is a real blocker: **v1.1.0 has low-level MCP primitives, but no public extension API was found for augmenting the existing native client's capabilities and handlers.** Reusing Pi's client class to create another connection would still be a second client, not an addition. Until a supported hook exists, a package may provide diagnostics or policy/UI helpers, but must not claim to supply these missing wire capabilities.

## 1. What “current” and “supported” actually mean

The official [versioning guide][versioning] explicitly says the **Current protocol revision is `2026-07-28`**. Protocol dates identify backwards-incompatible changes; backwards-compatible updates need not change the date. It defines:

| Term | Meaning; what it does not establish |
| --- | --- |
| **Draft** | In-progress, not ready for consumption. A published draft is not a production support target. |
| **Current** | Ready for use; may receive backwards-compatible changes. This is the recommended reference for new protocol work. |
| **Final** | Past, complete specification. Continued publication is not a promise that every client or SDK supports it. |
| **Implementation-supported** | A concrete client/server accepts that version and implements the applicable behavior. Check code and interoperability tests; do not infer this from the documentation menu. |
| **Deprecated feature** | Still in the specification, with a migration path and removal eligibility window. Not synonymous with “already removed” or with an entire old revision becoming unsupported. |

The official navigation publishes `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and Draft. That is a **publication inventory**, not a universal supported-version list. The reviewed versioning and lifecycle policies do not establish a universal “last N revisions” support requirement or an end-of-support date for each Final revision. Implementations **MAY** support multiple revisions. SDK removal/support timelines are separate from specification feature removal. [versioning], [lifecycle], [mcp-navigation]

### Feature lifecycle, not blanket version deprecation

The [feature lifecycle policy][lifecycle] normally requires at least **12 months from release of the revision marking the feature Deprecated** before removal eligibility. A documented active-security-risk exception requires approval and at least **90 days**. Eligibility is not automatic removal; features can remain deprecated longer.

The [Current deprecated registry][deprecated] records:

| Feature | Deprecated in | Migration / earliest removal |
| --- | --- | --- |
| Roots | `2026-07-28` | Pass paths through tool parameters, resource URIs, or server configuration; first revision released on/after **2027-07-28**. |
| Sampling | `2026-07-28` | Integrate directly with LLM provider APIs; same earliest revision date. |
| Logging | `2026-07-28` | stderr for stdio / OpenTelemetry; same earliest revision date. |
| Dynamic Client Registration | `2026-07-28` | Client ID Metadata Documents; same earliest revision date. |
| Sampling `includeContext: thisServer/allServers` | `2025-11-25` | Omit or use `none`; removal follows Sampling. |
| Old HTTP+SSE transport | `2025-03-26` | Streamable HTTP; special transitional eligibility: three months after SEP-2596 reaches Final. No calendar removal date verified here. |

The registry says no features have yet been removed **under this policy**. Do not broaden that into “the new revision removed nothing”: its [changelog][changes] explicitly removes/replaces handshake messages, HTTP session machinery, and other wire mechanisms.

The [SDK tier policy][sdk-tiers] requires Tier 1 SDKs to implement optional non-experimental capabilities, including sampling and elicitation. That is an **SDK tier/completeness obligation**, not a rule that every host application must expose every optional feature. Nothing reviewed establishes Pi's SDK tier or certifies it as fully conformant.

## 2. Normative requirements: optional adoption, mandatory behavior once adopted

For Pi's newest supported revision, [`2025-11-25` basic protocol][legacy-basic] says all implementations **MUST** implement the base protocol and lifecycle; other components **MAY** be implemented according to application needs. Its [lifecycle][legacy-lifecycle] requires initialization, version agreement, the initialized notification, and use only of successfully negotiated capabilities.

For Current [`2026-07-28`][modern-basic], all implementations **MUST** implement the base protocol, versioning, and message patterns; other components **MAY** be implemented. Required per-request metadata includes protocol version and client capabilities. Servers must not rely on undeclared capabilities and must return the specified missing-capability error when needed. Servers **MUST** implement `server/discover`; clients **MAY** call it. Modern version mismatch uses `UnsupportedProtocolVersionError` rather than the legacy initialization exchange. [modern-versioning]

Consequences:

- Missing optional sampling, elicitation, prompts UX, or resource subscriptions is **not by itself nonconformance**. Describe these as feature gaps.
- Advertising a capability without implementing its required behavior is a different issue. Advertise only modes/sub-capabilities actually available in the session and permitted for that server.
- Advertising `2026-07-28` requires its mandatory base behavior. Adding that date to Pi's accepted-version array would not implement compatibility.
- This review does not audit every base requirement or security property. “Present in source” is not a blanket conformance verdict.

## 3. Native v1.1.0 versus candidate additions

**Native** below means the built-in coding-agent integration, not merely a type or generic request method in `@earendil-works/pi-mcp`.

| Area | Native implementation at pinned v1.1.0 | Candidate gap / normative boundary / decision |
| --- | --- | --- |
| **Form elicitation** | Runtime constructs `McpClient` with roots only; no elicitation capability, handler, or form UX. Low-level client permits capability options and `setRequestHandler`, but native does not install one. [pi-runtime], [pi-client] | Good first optional addition **after the hook**. Supporting clients must declare elicitation; `elicitation: {}` means form-only, not every mode. Omitted `mode` means form. Support accept/decline/cancel, server attribution, and review/edit before sending. Servers must not solicit secrets through forms. [legacy-elicitation], [modern-elicitation] |
| **URL elicitation** | No native URL-elicitation workflow; existing OAuth login is not this feature. [pi-runtime], [pi-doc] | Separate opt-in follow-up. Declare `elicitation.url`, validate requests, obtain explicit consent, show the full URL, never prefetch, and open outside agent-observable browsing. Third-party secrets must not transit the client. This is distinct from authenticating Pi to the MCP server. [legacy-elicitation], [modern-elicitation] |
| **Sampling** | Capability type exists; generic handler registration exists. No built-in `sampling/createMessage` handler or sampling capability advertisement. [pi-types], [pi-client], [pi-runtime] | Optional gap, **not first scope**: deprecated in Current. Any exceptional legacy bridge needs explicit demand, user/model/cost controls, `maxTokens` enforcement, data isolation, and separate `sampling.tools` support before tool-enabled requests. Do not expose Pi conversation context by default. [deprecated], [legacy-sampling], [modern-sampling] |
| **Roots** | **Already present**: advertises `roots: {}` and responds to `roots/list` with a single `file://` URI for session cwd. Low-level options also accept an asynchronous roots supplier. Native supplies a fixed array, no `listChanged: true`, and no roots-change workflow. [pi-client], [pi-runtime] | Not a missing basic feature. Dynamic/multiple roots would be an enhancement, but Current deprecates roots. Prefer tool/config/resource inputs. Root lists are not an OS sandbox. Do not add change notifications unless the legacy capability is actually supported; Current removes that notification. [legacy-roots], [modern-roots], [changes] |
| **Prompts** | Server capability type is represented, but no native `prompts/list`, `prompts/get`, prompt picker, or prompt-list refresh path. Generic `request()` is only a low-level building block. [pi-types], [pi-client], [pi-runtime], [pi-index] | Useful later optional addition via native request access. Prompts are user-controlled, not server instructions to execute automatically. Supporting servers declare `prompts`; validate inputs/outputs and preserve explicit user selection. Implement pagination and negotiated list changes. [legacy-prompts], [modern-prompts] |
| **Argument completion** | `completions` server capability type exists; no native `completion/complete` integration. [pi-types], [pi-client], [pi-index] | Later alongside prompts/resource-template UX. This is argument suggestion, **not LLM sampling**. Gate on server capability, validate input, rate-limit, avoid leaking sensitive suggestions, and debounce UI requests. [legacy-completion], [modern-completion] |
| **Resource listing, templates, reading** | **Already implemented**: paginated client methods, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`; text/image handling and file output for other binary data. Resource list-change notifications refresh native inventory. [pi-client], [pi-resources], [pi-runtime] | Do not reimplement baseline resources. Possible later enhancements are template argument UX and completion. Native intentionally filters MCP App resources (`ui://` / `text/html;profile=mcp-app`) and omits icons; these are not proof that resource support is absent. [pi-resources] |
| **Resource subscriptions** | No native `resources/subscribe`, `resources/unsubscribe`, or resource-content update workflow found. List-change refresh is implemented and is a different feature. [pi-runtime], [pi-client] | Optional later gap. Legacy `resources.subscribe` and `listChanged` are independent server sub-capabilities. Current replaces subscribe/unsubscribe with `subscriptions/listen`; do not implement a legacy watcher and label it Current support. [legacy-resources], [modern-resources], [changes] |
| **stdio / Streamable HTTP** | Both native. HTTP supports JSON/SSE replies, legacy session IDs, post-initialization GET stream, version header, and SSE reconnection/resumption. Native docs explicitly reject old standalone SSE configuration. [pi-http], [pi-doc] | Leave transport ownership native. Streamable HTTP using SSE is **not** the deprecated HTTP+SSE transport. Do not add the latter merely to tick a published-version box. [legacy-transports], [modern-transports], [deprecated] |
| **Protocol revisions** | `LATEST_PROTOCOL_VERSION = "2025-11-25"`; accepted array is exactly `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. Client always initializes, validates the returned revision against that array, then sends `notifications/initialized`. [pi-types], [pi-client] | **No `2026-07-28` support** in this baseline. Current-only server interoperability is a real compatibility gap, not an optional-feature omission. Prefer upstream native implementation, not a package-owned modern transport/client. Acceptance of old protocol dates does not imply old HTTP+SSE transport support. |

### Elicitation cannot hide the protocol-era difference

A `2025-11-25` implementation handles server-initiated `elicitation/create` requests. Its URL mode includes `elicitationId`, optional `notifications/elicitation/complete` (ignore unknown/already-completed IDs), and the `-32042` URL-required error flow. Accepting a URL request means consent, **not** proof the external interaction completed. [legacy-elicitation]

In `2026-07-28`, servers must use **multi round-trip requests (MRTR)** instead of server-initiated JSON-RPC requests. They return `resultType: "input_required"`; the client may retry with `inputResponses` and the exact opaque `requestState`, using a new request ID. State and inputs are scoped to that original operation, never another parallel call. URL elicitation loses `elicitationId` and the completion notification; the client discovers completion through retry. The old `-32042` error must not be emitted by Current implementations. [mrtr], [modern-basic], [changes]

Other Current changes include per-request version/capabilities, mandatory server discovery implementation, `subscriptions/listen`, removal of HTTP session IDs and GET/resumability machinery, and different required HTTP metadata. These are **native protocol work**, not UI embellishments. Supporting forms on Pi v1.1.0's legacy connection does not make the package Current-compatible. [modern-versioning], [modern-transports], [changes]

## 4. Additive integration feasibility

The public extension surface exposes `registerMcpServer`, `unregisterMcpServer`, and `getMcpServers`. The latter returns **extension registrations**, not handles for every active configured connection. `McpServerConfig` has transport/auth/exposure settings, not client capability or request-handler callbacks. [pi-api], [pi-config]

The built-in extension keeps server instances in its closure; its runtime owns the `McpClient`. `McpClient.request`, `notify`, `onNotification`, `setRequestHandler`, and constructor capabilities are useful primitives, but there is no reviewed public API that hands an ordinary extension the native live client or permits pre-initialization capability augmentation. The internal `createMcpExtension` transport-injection option is not such a shared-client extension API. [pi-index], [pi-runtime], [pi-client]

**Do not work around this by registering `/mcp`.** Native Pi explicitly treats an installed extension owning that command as a replacement: it stops reading/connecting native session MCP configuration. Likewise, do not disable `builtin:mcp`, patch private/prototype internals, or open duplicate stdio/HTTP connections. `mcp_servers_change` concerns server registrations and connection ownership; it is not a client capability hook. [pi-doc], [pi-api]

A proposed upstream hook should provide:

1. Server-scoped opt-in capability contributions **before legacy initialization**, plus handler registration and disposal. Activation/deactivation on a live legacy connection needs native-managed renegotiation/reconnect, not an unannounced capability change.
2. Native-owned cancellation, timeout, disconnect, reload, and reconnect lifetimes; no orphaned user questions or handlers.
3. Read-only negotiated-version/server-capability inspection and narrow native request/notification access for prompts/completion/subscriptions, without exposing stored credentials or bypassing trust and permissions.
4. A future native MRTR input-provider interface so the same elicitation UI can survive a protocol upgrade without the package taking over transports/retry state.
5. Explicit feature ownership/detection to avoid duplicate handlers when Pi later implements the feature itself.

These are **design recommendations**, not APIs available in v1.1.0.

## 5. Bounded first delivery and retirement policy

### Deliver first

- Establish the native hook/API contract upstream. If unavailable, stop at a compatibility diagnostic; do not silently expand into a replacement client.
- After that, implement **per-server opt-in form elicitation**, initially test-qualified for **`2025-11-25`**. Advertise only `{ elicitation: { form: {} } }` when an interactive handler is available; no implicit headless approval or model-generated consent.
- Cover the revision's restricted form schemas, including primitive fields and single/multi-select enums, rather than assuming arbitrary nested JSON Schema or ignoring allowed array enums. Validate responses, attribute the server, allow editing, distinguish decline/cancel, bound size/concurrency/time, and dispose pending UI on shutdown.
- Test existing tool/resource calls and native trust/auth/exposure unchanged; capability-on/off, malformed/unsupported modes, cancellation, reconnect/reload, and no duplicate connection/command ownership. Do not claim older-revision elicitation support simply because native Pi accepts those revisions.

### Then, only on demonstrated demand

1. **URL elicitation**, independently enabled and tested, including the legacy URL-required error/completion/manual-retry paths. Do not use an agent-readable collaborative browser for credential entry. No automatic URL fetch or navigation.
2. **User-selected prompts and argument completion**, reusing native server connections.
3. **Resource subscriptions**, only if a real workflow needs updates; design against the protocol version rather than one generic “subscribe” label.

Exclude new sampling, expanded roots, standalone legacy SSE, MCP Apps rendering, and modern protocol replacement from the first scope. Preserve working native roots and resources; deprecation is not authorization to remove them from someone else's runtime.

### Retire, rather than compete

For each feature, record minimum tested Pi version, negotiated protocol revision, required hook version, and whether native or package code owns it. On native parity, switch the default to native, stop advertising/installing the package handler, document any setting migration, and remove the shim after a stated package deprecation window. Prefer explicit native feature detection, not only a guessed Pi version threshold. Package retirement policy is separate from MCP's specification deprecation policy.

## 6. Unknowns and follow-up gates

- **Public hook availability:** no adequate hook found in reviewed v1.1.0 source. Whether upstream will accept one, or has added one after this tag, remains unverified.
- **Interoperability:** no conformance suite or live-server matrix was run. Native's accepted-version constants establish negotiation intent, not exhaustive correctness for every server, revision, and transport combination.
- **Product demand:** which actual servers require forms, URL mode, prompts, subscriptions, or a Current-only protocol? Obtain concrete examples before choosing follow-up scope.
- **Interaction surfaces:** TUI, RPC, embedded SDK, and noninteractive mode need separate capability/consent policies. Browser isolation and headless request presentation are not established by this review.
- **Modern migration:** wait for native protocol support or an explicitly approved upstream project; a legacy input handler cannot implement MRTR or modern subscriptions by itself.
- **Policy limits:** no universal old-revision EOL/support schedule was found in the official policies reviewed. Do not publish one by inference. Recheck Current and the deprecated registry before implementation/release; official Current pages can change without a new protocol date.
- **Security audit:** this is not a full audit of Pi's root consent, OAuth, schema validation, or transport behavior. Such checks need their own bounded work; optional omissions alone are not findings of nonconformance.

## Primary sources

All following pages/source files were directly retrieved or read during this review. Website links are revision-specific where possible; Pi code links are commit-pinned.

[versioning]: https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning
[lifecycle]: https://modelcontextprotocol.io/community/feature-lifecycle
[deprecated]: https://modelcontextprotocol.io/specification/2026-07-28/deprecated
[sdk-tiers]: https://modelcontextprotocol.io/community/sdk-tiers
[mcp-navigation]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/c518f7a927cff918bce35d3522fcdb046d264d7c/docs/docs.json
[legacy-basic]: https://modelcontextprotocol.io/specification/2025-11-25/basic
[legacy-lifecycle]: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
[modern-basic]: https://modelcontextprotocol.io/specification/2026-07-28/basic
[modern-versioning]: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
[changes]: https://modelcontextprotocol.io/specification/2026-07-28/changelog
[mrtr]: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
[legacy-elicitation]: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
[modern-elicitation]: https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
[legacy-sampling]: https://modelcontextprotocol.io/specification/2025-11-25/client/sampling
[modern-sampling]: https://modelcontextprotocol.io/specification/2026-07-28/client/sampling
[legacy-roots]: https://modelcontextprotocol.io/specification/2025-11-25/client/roots
[modern-roots]: https://modelcontextprotocol.io/specification/2026-07-28/client/roots
[legacy-prompts]: https://modelcontextprotocol.io/specification/2025-11-25/server/prompts
[modern-prompts]: https://modelcontextprotocol.io/specification/2026-07-28/server/prompts
[legacy-completion]: https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion
[modern-completion]: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/completion
[legacy-resources]: https://modelcontextprotocol.io/specification/2025-11-25/server/resources
[modern-resources]: https://modelcontextprotocol.io/specification/2026-07-28/server/resources
[legacy-transports]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
[modern-transports]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
[pi-types]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/mcp/src/protocol/types.ts
[pi-client]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/mcp/src/client.ts
[pi-runtime]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/extensions/mcp/runtime.ts
[pi-index]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/extensions/mcp/index.ts
[pi-resources]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/extensions/mcp/resources.ts
[pi-http]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/mcp/src/transports/streamable-http.ts
[pi-api]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/extensions/types.ts
[pi-config]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/mcp-servers.ts
[pi-doc]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/mcp.md
