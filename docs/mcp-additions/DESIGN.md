# MCP additions: native-client extension boundary

Status: **proposal, not an implemented Pi API or a working extension**.

This is the first milestone for `packages/mcp-additions`. Do not install a placeholder package or advertise capabilities until the native hook below exists. Pi 1.1.0 does not expose it. Current native Computer Use remains blocked; this document is not evidence of a successful approval or screenshot test.

## Goal and non-goals

Supply opt-in client capabilities missing from Pi's native MCP implementation, then remove each addition when an equivalent native implementation is available. Keep a single owner of every connection and every request route.

Pi continues to own server configuration and project trust, transport and OAuth, protocol negotiation, tool/resource registration, tool execution and results, and connection shutdown. The package supplies specific client-request behavior and user interaction. It must not register `/mcp`, launch a second connection, intercept stdio, patch private Pi objects, alter the initialization exchange behind Pi's back, or replace OpenAI's server.

Optional capabilities are not universally required by MCP. Implementing one adds functionality; its absence alone does not make Pi noncompliant. See [the compatibility investigation](COMPATIBILITY.md) for the separately researched protocol/version scope.

## Verified host boundary

Inspected Pi tag `v1.1.0`:

- [`ExtensionAPI`](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/extensions/types.ts) exposes `registerMcpServer`, `unregisterMcpServer`, and `getMcpServers`, not client-feature registration.
- [The loader](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/extensions/loader.ts) supplies those server registrations.
- [The built-in MCP extension](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/extensions/mcp/index.ts) owns session startup, server configuration, and shutdown.
- [`connectOnce()`](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/extensions/mcp/runtime.ts) constructs a native `McpClient` with name, version, timeout, and roots. It does not accept extension-provided client handlers.
- [The lower-level client](https://github.com/earendil-works/pi/blob/v1.1.0/packages/mcp/src/client.ts) already accepts capabilities and has `setRequestHandler()`. These are useful implementation primitives, not a public coding-agent extension hook. A package importing a second client would not augment the existing connection.

**Upstream work is required before live package integration.** A new package alone cannot meet the chosen architecture today.

## Minimal upstream proposal

The following names are illustrative, not calls a package can make in current Pi:

```ts
// PROPOSED API, not shipped by Pi.
pi.registerMcpClientFeature({
  id: "elicitation.form",
  prepare: async (connection) => {
    // Native Pi resolves ownership before this runs.
    // No transport, credentials, or raw client object is exposed.
    // Return undefined unless explicitly enabled for this server and UI is usable.
    return {
      handle: async (request) => { /* validate -> prompt -> validate -> reply */ },
      dispose: async () => { /* idempotent feature-owned cleanup */ },
    };
  },
});
```

Use a **typed, host-owned form-elicitation slot**, not arbitrary JSON capability merging or a general plugin router. Start with a single feature ID, `elicitation.form`. The example's generic-looking API name is provisional: the first implementation may expose a form-specific registration method. Do not implement sampling, subscriptions, URL approval, or alternate protocol lifecycles in this slice.

For the one supported form feature, the host defines:

- Applicable negotiated revisions and version-specific capability encoding.
- Incoming method and routing discriminator (for elicitation: omitted mode/form versus URL).
- Allowed result shape and error semantics.
- Native implementation ownership, independent of user enablement.
- Handler contract revision, so a package cannot silently attach to an incompatible API.

This prevents an extension from claiming a capability without its handler, replacing roots or another client's functionality by object merge, or using a form handler to accidentally accept a URL request. Unknown feature IDs fail at registration. Future additions are deliberate host API extensions.

This is **not merely exposing `setRequestHandler()`**. The form-only native patch needs registration/ownership reporting, initialization wiring, request identity/context, cancellation linkage, a final response-send guard, and disposal. The package owns policy, schema validation, dialogs, and review. Keep arbitrary method routing and multi-feature composition out of this first patch.

### Registration and initialization

1. Register synchronously during extension loading; do not open connections or dialogs there.
2. Once trusted server configuration and session UI are available, Pi computes a per-connection feature plan.
3. Native implementation ownership wins, even if the user disabled that native feature. An extension must not reactivate it.
4. If multiple extensions claim the same missing feature, report a conflict and leave that feature unadvertised; unrelated tools/connections remain usable. Do not choose by load order.
5. Call the selected provider's `prepare()` once for a fresh connection generation. Its input is immutable and bounded: server name, transport kind, connection generation, the selected offer profile, UI interface, and lifetime signal. No secrets or raw mutable client. Preparation must not prompt the user or perform network access. Give it a host-enforced one-second deadline within the overall connection budget; abort on timeout/disconnect. Timeout or failure continues ordinary native initialization without this feature. Dispose any late-returned instance without ever attaching it; a disconnected generation must not continue initialization.
6. A provider returning `undefined` has not enabled the feature. Unsupported UI, absent opt-in, invalid policy, or preparation failure must never advertise it.
7. Pi atomically installs handlers and builds the corresponding advertised capabilities **before** `initialize`.
8. The first development profile explicitly offers **2025-11-25**, with `capabilities.elicitation = { form: {} }`. Require that exact selected revision before completing initialization. A different selection closes this attempt with an actionable profile-mismatch diagnostic: no tools/call, no approval UI, and no automatic downgrade/retry. Disabling the feature and explicitly reconnecting restores Pi's ordinary negotiation. This constrained opt-in profile changes only that server's connection policy. Form-only encoding and omitted-mode behavior are specified in the [2025-11-25 elicitation specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation). It is an interoperability development target, not a claim that every official revision is supported. Add other profiles only after version-policy research and wire tests; constraining dispatch after a bad advertisement is not sufficient.
9. Reuse only the already-owned native connection for tools/results, including image blocks. Never retry the original tool call merely because approval or delivery failed.

Preparation is not permission. Every server request still requires its own authorization path.

### Incoming request context

Pi supplies a dedicated request context rather than a captured `tool_call` context:

- Server and connection generation identity; request ID; negotiated version.
- Original parameters and permitted metadata, treated as untrusted data.
- Abort signal combining request cancellation and connection/session lifetime.
- Supported dialog methods and an overall deadline.
- Initiating tool correlation only when known. Never guess which concurrent tool owns a server request.

Request IDs are connection-scoped. A result must never be delivered to a new connection after reload. Responses must be validated and delivered at most once. Late UI replies are discarded after cancellation.

**Cancellation policy for the first slice:** when there is reliable parent-request correlation, cancelling that operation invalidates its associated approval requests. Without correlation, cancellation of any outgoing tool call on a form-enabled connection invalidates all outstanding approvals on that connection and puts form handling into a fail-closed quarantine until explicit reconnect. Reject further elicitation there without prompting; other uncancelled operations may consequently fail rather than receive accidental approval. This deliberate availability trade-off handles servers that never send incoming-request cancellation and late requests whose parent cannot be identified. Report the reconnect requirement, never silently replay work. Do not claim it is possible to retract an acceptance already transmitted before cancellation.

The lower-level client's response-send path must check request abort state, connection generation, and the quarantine/validity token immediately before handing a successful reply to the transport, with no intervening asynchronous work. A handler resolving after cancellation must never send an acceptance. Wire tests must cover concurrent tools and a server that ignores cancellation. Current Pi's incoming abort signal alone does not establish this guarantee.

The host should not expose a general model-callable "approve request" tool. Human approval is user interaction, not an agent action.

### Disposal and reconfiguration

Registration returns a disposer. Connection generation disposal aborts active requests and removes queued dialogs, then awaits bounded feature cleanup. It is idempotent across timeout, disconnect, reload, session switch, and normal shutdown.

Changes cannot mutate the capability contract of an initialized connection. Mark them as requiring reconnect; do not silently terminate active tool calls or replay them. Removing a provider immediately prevents further successful approvals; rebuild advertised capabilities on the next explicit reconnect. Reload follows Pi's existing session-shutdown/reconnect lifecycle.

CLI discovery without UI, print mode, and JSON mode must not advertise interactive approval features. RPC's `hasUI` is necessary but not proof that a particular host renders dialogs: use bounded waits and cancellation, and separately validate T3 end-to-end.

## First package slice: form elicitation

### Policy

- Off by default; explicit per-server enablement.
- No global `mcp.json` mutation or surprise enablement by installing the package.
- No auto-approval based on a model's assertion that the user authorized the task.
- No remembered approval cache in the initial implementation. Return the user's explicitly selected values in response to each actual server request.
- No arbitrary provider-module loading from an untrusted project.
- Requests outside the selected revision's form schema are rejected/cancelled with a clear diagnostic, not approximated or submitted as unchecked JSON.
- Do not add sampling, URL elicitation, or browser launching to this first slice.

A package-specific policy file is preferable to extending native `mcp.json` with unknown keys. Exact path/schema should be settled with the upstream hook. Project overrides require Pi's trusted-project boundary; global and project merge semantics need explicit tests. Do not implement that configuration spec prematurely.

### Human interaction

Build on Pi's existing `ctx.ui.select`, `input`, and `confirm` support, which has an [RPC request/response protocol](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-extension-ui.md). Do not depend on custom terminal UI in RPC mode.

1. Identify the configured server and display the request as untrusted server text.
2. Offer decline/cancel before collecting values.
3. Collect supported fields without silently accepting server defaults. Cover the selected revision's primitive fields and single/multi-select enum schemas; allowed array enums must not be mistaken for arbitrary nested forms.
4. Validate values against the complete allowed original schema, without remote schema fetches.
5. Present the exact response for review, allow returning to edit answers, and require an explicit send action for every input path.
6. Return accept only after validation, review, and a final cancellation check.

Bound schema bytes, nesting, field count, choices, input length, retry count, queue length, and total time including time queued. Avoid unbounded regex validation. Serialize dialogs across all servers using one session-owned queue. Test cancellation both while queued and while a dialog is open.

Don't request passwords/tokens through forms. Detect obvious sensitive fields as defense in depth; don't claim heuristic names establish secret safety. Unsupported or sensitive forms fail closed; no raw JSON escape hatch in the initial package.

### Computer Use acceptance profile

This is a vendor-specific test profile, not part of the generic MCP standard:

- Use the existing signed OpenAI runtime and SSH launch configuration.
- Verify approval request identity for Calculator (`com.apple.calculator`) and the actual requested operation.
- For this authorized test, restrict approval answers to session-only; never select `always` or reinterpret it as session.
- Preserve required vendor metadata and validate the actual server schema rather than guessing response fields.
- Decline unexpected app/operation/scope requests. If the requested schema cannot express session-only approval, stop.
- Do not modify macOS permissions, authentication checks, or app policy storage.
- Observe accessibility state, perform `2 + 2`, refresh state, and forward an actual screenshot through native Pi/T3. Do not substitute an old diagnostic-client screenshot.

An explicit scope restriction must be enforced at response validation as well as UI presentation. Hiding an "always" option alone is insufficient. No persistent grant may be sent via a JSON path or forged UI response.

## Reuse, without inheriting a replacement client

The existing [`mcp-client`](../../packages/mcp-client/README.md) package has useful `input.ts`, `forms.ts`, and tests for elicitation. Reuse reviewed validation/UI ideas or extract a transport-independent component later. Do not import its extension entry point, connection manager, `/mcp` command, or configuration loader into the new package.

Changes required rather than blind copying:

- Complete form answer review on **every** acceptance path.
- Bounded, session-scoped queue and connection-bound cancellation.
- Explicit approval scope restrictions for the Computer Use test.
- No raw JSON path bypassing sensitive-field and scope controls.
- Version-aware capability/dispatch ownership managed by native Pi.

The new package remains opt-in and is not added to the collection's autoload list while experimental. Installing it alongside a replacement `/mcp` implementation must report that no native feature host is available, not start a replacement host itself.

## Retirement contract

Native ownership must be an explicit host report for a feature/contract revision, not inferred from the Pi version string or the presence of `elicitation` somewhere in a capability object.

Feature states:

- `unavailable-host`: required public hook absent; no registration or capability claims.
- `disabled`: user has not enabled it, or no usable UI.
- `unsupported-protocol`: host cannot safely negotiate this implementation.
- `native`: Pi owns this feature; package does nothing regardless of native enablement.
- `extension`: exactly one explicitly enabled compatible provider owns it.
- `conflict`: multiple providers; feature stays unavailable with an actionable diagnostic.

When native support lands: run the same acceptance suite, document remaining differences, stop activating the package feature for compatible native hosts, then remove its code once the package's supported host floor makes it redundant. A partial native feature must not be silently shadowed. Resolve the missing native behavior upstream or through a separately defined nonoverlapping hook.

Do not pin users to old Pi releases to preserve an extension feature. Do not declare the addition retired based solely on a changelog entry.

## Delivery gates

See [ACCEPTANCE.md](ACCEPTANCE.md) for testable requirements.

1. Verify official version policy and tag-pinned native behavior; publish compatibility matrix.
2. Review the upstream hook proposal, settle precise types/error semantics, implement in a development Pi checkout, and pass native lifecycle/transport tests. No installed-binary patching.
3. Implement the opt-in form package against that actual public API, with deterministic tests and both repository package-manager checks.
4. Test RPC dialogs using a local harmless MCP fixture and explicit user input through T3.
5. Reconnect the Mac server with session-only authorization; verify Calculator accessibility and image rendering end to end.
6. Expand scope only after choosing the next capability from the matrix.

At the current milestone, gates 2–5 remain open. No existing installation, server configuration, approval policy, or desktop state is changed by these design documents.

## Design review disposition

Independent review identified four material gaps in the first draft; the proposal now specifies conservative uncorrelated-cancellation quarantine and a response-send guard, a concrete exact-revision development offer with no automatic fallback, bounded preparation with late-resource disposal, and a form-only native vertical slice rather than a generalized feature router. These are design revisions, not implemented fixes or passing test results. The larger-than-originally-described upstream lifecycle work remains an explicit implementation prerequisite.
