# MCP coverage and audit disposition

This is a tested capability matrix, **not conformance certification**. Optional extensions are not core conformance requirements. Server capabilities and local opt-ins gate behavior.

| Capability                                   | 2024-11-05                                     | 2025-03-26             | 2025-06-18              | 2025-11-25                       | 2026-07-28                                  |
| -------------------------------------------- | ---------------------------------------------- | ---------------------- | ----------------------- | -------------------------------- | ------------------------------------------- |
| Initialize/initialized                       | Yes                                            | Yes                    | Yes                     | Yes                              | Replaced by discovery                       |
| Stdio                                        | Yes                                            | Yes, including batches | Yes                     | Yes                              | Yes                                         |
| Original HTTP+SSE                            | Explicit selection                             | Explicit selection     | Compatibility transport | Compatibility transport          | Not supported by revision                   |
| Streamable HTTP                              | Not defined in revision                        | Yes, including batches | Yes                     | Yes                              | Stateless POST/request streams              |
| Tools/resources/templates/prompts/completion | Yes; no later completion capability required   | Yes                    | Yes                     | Yes                              | Yes                                         |
| Progress/cancellation                        | Yes                                            | Yes                    | Yes                     | Yes                              | Yes; HTTP stream abort                      |
| Roots/basic sampling                         | Opt-in                                         | Opt-in                 | Opt-in                  | Opt-in                           | Opt-in, deprecated, not removed             |
| Form elicitation                             | Not defined                                    | Not defined            | Opt-in                  | Opt-in                           | Opt-in MRTR                                 |
| URL elicitation / sampling tool proposals    | Not defined                                    | Not defined            | Not defined             | Separately opt-in                | Separately opt-in MRTR                      |
| Request metadata, mirrored headers, MRTR     | —                                              | —                      | —                       | —                                | Yes                                         |
| Explicit notification subscriptions          | Legacy notifications                           | Legacy notifications   | Legacy notifications    | Legacy notifications             | Acknowledged/filter-correlated streams      |
| TTL-aware tool discovery                     | —                                              | —                      | —                       | —                                | Yes; connection-private catalogs            |
| OAuth                                        | HTTP public-client flow; not revision-specific | Same                   | Same                    | Same                             | Same                                        |
| Tasks                                        | —                                              | —                      | —                       | Experimental form not advertised | Opt-in standard extension, explicit polling |
| Apps / remote Skills installation            | Not advertised                                 | Not advertised         | Not advertised          | Not advertised                   | Not advertised                              |

## Native Pi alignment pass

Native Pi **1.1.0** is the host-integration reference; MCP specifications remain
wire authority. See the [audit](../../docs/mcp-client-alignment/AUDIT.md) and
[implementation status](../../docs/mcp-client-alignment/README.md). This pass does
not establish full native exposure/codemode parity or unrestricted conformance.

New regression coverage:

- `approval-lifetime.test.ts`: legacy operation cancellation/deadline retires the
  connection and late approvals; modern MRTR cancellation stays operation-scoped;
  collected batches cannot reply after shutdown; repeated close is idempotent.
- `peer.test.ts`: legacy `resultType` fields remain data, not modern input/retry
  instructions, across all four accepted legacy revisions.
- `result-compatibility.test.ts`: structured-only results, malformed-field
  rejection, ordinary legacy task-like data, output-schema checking, image/error
  preservation, and real stdio cancellation/deactivation/process exit.
- `forms.test.ts`: review/edit on both guided and JSON paths, unknown modes,
  cancellation checks, heuristic secret rejection, and current enum schemas
  through the reviewed JSON path. Guided titled/multi-enum controls remain absent.
- `elicitation-version.test.ts`: negotiated-version URL validation and Current
  MRTR consent without a legacy `elicitationId`, using fake UI/browser opening.

- `native-config.test.ts`: read-only native import, timeout units, enabled flags,
  partial overrides, exposure preservation, registrations and fail-closed options.
- `native-host.test.ts`: exposure matching, identities, annotations/namespaces,
  full script results without top-level metadata, resource images and settings.
- `computer-use-approval.test.ts`: exact app/operation eligibility, human selection,
  session-only metadata, malformed/permanent-scope rejection, cancellation and
  legacy/MRTR forwarding. This is not live server authorization evidence.
- `form-review.test.ts`: full-value paged review and bounded fail-closed behavior.
- `lifecycle.test.ts`: startup abort/deadline, bounded cleanup and Linux process
  group/wrapper/grandchild ownership; macOS/Windows cleanup remains unverified.
- `scripts/native-rpc-smoke.mjs`: actual Pi **1.0.3 and 1.1.0** passed an isolated
  synthetic-server RPC scenario: names, hidden rejection, registered servers,
  session-only fixture approval, resources, errors and codemode image output.
  Test-driver selection is not a human T3 dialog/rendering test.

Native mode leaves native files unchanged for safer rollback and refuses
unsupported semantics. Package-mode rollback still requires native-format files.
The actual T3 synthetic fixture subsequently passed human session-only approval
and visible image delivery. The existing signed Mac server connected, but two
Calculator selections initially returned `-10005: cgWindowNotFound`. A
user-requested retry then delivered live Calculator AX state and a fresh screenshot.
The subsequent Convert-menu action returned `Computer Use was not approved to
use Calculator`; the user reported no denial. Inspection found the missing
client-side session-grant reuse. After that fix, the live Pi/T3 scenario completed:
**2 + 2 = 4**, fresh AX expression/result plus screenshot, and an approval history
of **one human acceptance and 11 scoped session reuses** (click, press_key and
get_app_state). No permanent grant or OS permission change. This proves this
bounded Calculator scenario, not arbitrary apps or exhaustive conformance.

## Confirmed audit defects

| Finding                                                       | Resolution / regression coverage                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid root-ref/composed/omitted-type schemas excluded         | Original schema compiled locally; object argument envelope preserved. Real Pi registry/TypeBox and execution tests.                                                                |
| Legacy session 404 / missing DELETE                           | Fresh initialization prepares future calls; failed operation is never replayed. Best-effort bounded DELETE on shutdown.                                                            |
| Unbounded protocol errors and legacy bodies                   | Execution errors use the same presentation/artifact limits; byte-bounded fetch covers JSON, SSE and HTTP errors. Catalog/schema work budgets added.                                |
| Incomplete connection deadline / initialize cancellation      | Overall setup deadline includes initialized and fallback; initialize is never cancelled.                                                                                           |
| Administrative commands delayed and added to context          | Immediate native custom entries with entry renderer, not messages. Real Pi session test verifies no pending/context messages.                                                      |
| Lost content order, prompt images, metadata, binary expansion | Ordered blocks; prompt roles remain reference labels; structured/text deduplication; raw result retained in details or private artifact. Unsupported binary is not Base64 context. |
| Whitespace-corrupted command JSON                             | Parse only the action prefix; retain the remaining JSON verbatim.                                                                                                                  |
| Stale catalog metadata                                        | Honor modern TTL (including absent/zero), refresh before turns, isolate caches to Peer/identity; reuse unchanged Pi definitions.                                                   |
| Subscription closure/refusal and reload persistence           | Track graceful closure, missing/refused acknowledgment, and accepted filters; branch-local desired subscriptions restored with configuration identity checks.                      |
| Competing cross-server dialogs                                | Shared queue for elicitation, sampling and OAuth login.                                                                                                                            |
| Older batch/completion behavior                               | 2025-03-26 stdio and HTTP JSON/SSE batches, including grouped replies; 2024 completion does not require later capabilities.                                                        |
| Empty opaque cursor discarded                                 | Presence check, not truthiness; cycle/page/aggregate budgets retained.                                                                                                             |
| Artifact reference lost during compaction                     | Reference placed first; tested with Pi's actual `serializeConversation`. No compaction replacement.                                                                                |

## Pi integration decisions

- Keep lifecycle hooks, project trust, native tool registration, default result rendering, the failure-only status slot, and normal Pi tool hooks.
- `toolLoading: "deferred"` uses only `setActiveTools()` and Pi's built-in deferred loading. No second agent/framework, custom tool-search protocol, or hidden model call.
- OAuth credentials are separate from model-provider auth. Sampling remains one doubly approved model-registry completion; optional server-tool proposals never execute Pi tools.
- Task handles and answered-input keys are durable branch entries. Waiting/resumption is explicit. No automatic background model turns or original-call replay.
- Guidance, annotations and icon descriptors are data, not trusted instructions, permission grants, or URLs to fetch.

## Deliberate boundaries

- **Apps need a real browser host.** No iframe/HTML execution or claim that terminal rendering implements MCP Apps.
- **Remote Skills need a host security model.** Plain resource access is not skill approval. Native skill installation would need server/URI provenance, content-bound approval, digest/size verification, safe materialization and support-file read mediation. This package does not bypass those requirements.
- OAuth supports public-client browser authorization, not every grant, enterprise extension, or confidential-client deployment. Redirects are refused; failed authenticated calls are not silently retried.
- No legacy experimental Tasks, task push subscriptions, shared sampling context, audio rendering, remote schema fetching, conditional catalog requests, or 2026 stream resumption.
- Bounded schema compilation is not a sandbox or a hard CPU deadline against malicious regular expressions. Configured servers remain trusted to run/access their advertised tools.
- Disabled definitions remain in Pi's registry until reload because Pi has no unregister-tool API. Large eager catalogs still consume context; deferred loading is opt-in for compatibility.

## SDK choice and independent tests

Runtime remains on SDK **1.32.1** for legacy transports and OAuth. The narrow batch adapter preserves batch boundaries through its single-message SSE parser without monkey-patching SDK internals. Stdio and 2026 HTTP have explicit, bounded transports. A wholesale SDK migration is not mixed into this repair.

Official SDK **2.0.0** server/node packages are **development-only** interoperability fixtures for modern stdio/HTTP, Unicode headers, MRTR and subscriptions. Other tests cover official SDK v1 HTTP/SSE, real Pi session/reload/deferred tools/compaction, loopback OAuth with PKCE/state, and mocked sampling. No billed model completions are needed.

References:

- [2026 core specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [2025 predecessor](https://modelcontextprotocol.io/specification/2025-11-25)
- [2026 Tasks](https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md)
- [Skills host requirements](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx)
