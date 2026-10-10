# MCP additions acceptance plan

Status: proposed tests, **not executed test results**. This defines release gates for the [design](DESIGN.md).

## Native host contract

| Scenario | Required observation |
| --- | --- |
| Pi 1.1.0 without proposed hook | Explicit unsupported-host status; zero connections, handlers, or capability changes by the package |
| Package absent or feature not enabled | Existing native behavior unchanged |
| Native form support enabled | Native handler only; package form provider not prepared |
| Native form support present but disabled by user | No extension fallback re-enables it |
| Two extension providers claim form | Conflict diagnostic; no form capability; ordinary native tools still work |
| URL request in form-only slice | Reject without invoking form UI; no URL capability advertised |
| Provider preparation fails or never settles | One-second preparation deadline; no advertised feature/dangling handler; ordinary initialization continues within its overall budget |
| Disconnect during preparation; provider returns late | No stale initialization; dispose late resources without attaching handlers |
| No UI, print/JSON, standalone CLI discovery | No interactive elicitation capability |
| Initialization | Form handler installed before offer; initial development profile offers exactly 2025-11-25 with `elicitation: { form: {} }` |
| Negotiation selects a different revision | Close the attempted connection before initialized/tools/UI; explicit profile-mismatch diagnostic, no automatic fallback or tool replay |
| Unsupported/new revision | Explicit unsupported state until reviewed/tested; no string-order inference |
| Register/remove after initialization | Reconnect-needed status; no live capability mutation or tool replay |
| Reload/disconnect/session switch | Abort handlers/queued prompts, discard late answers, dispose once |
| Same request ID on new connection | Old answer cannot resolve new request |
| Parallel tools/server requests | Correct connection/request identity; no guessed parent-tool attribution |
| Cancel outgoing call, reliable correlation | Associated approvals invalidated; no late acceptance |
| Cancel outgoing call, unknown correlation, server ignores cancellation | All outstanding connection approvals invalidated; later elicitation rejected until explicit reconnect; report quarantine |
| Cancel immediately before reply send | Native final-send guard rejects late acceptance; already-transmitted answers are not claimed retractable |
| Server attempts unsolicited request | Validate applicable protocol association rules before opening UI |

Use local stdio and HTTP fixtures for native integration. Assert wire messages and handler ownership, not just helper return values. Ensure a request arriving immediately after initialization is handled correctly.

## Form validation and authorization

- Valid supported scalar/enum forms, including the selected revision's single/multi-select enums, are accepted only after field validation and final review; users can return from review to edit answers.
- Omitted optional fields, `false`, zero, and empty strings preserve their distinct meanings.
- Omitted `mode` and explicit `form` follow the negotiated revision; `url` is never treated as form.
- Invalid schema, unsupported keywords, references, oversized input, too many fields/choices, and sensitive fields fail closed without schema fetching.
- Server defaults never become user authorization automatically.
- Both explicit decline and cancellation map to their proper protocol responses.
- A malformed/out-of-list UI response, invalid JSON-like value, or prototype-looking property cannot bypass validation.
- Overall deadline includes queue wait. Expired, aborted, or disconnected requests cannot send acceptance.
- Queue capacity is bounded; cross-server dialogs do not overlap or starve indefinitely.
- Every accept path requires final review. No raw JSON fallback bypasses review or approval-scope restrictions.
- Repeated Computer Use approval requests require repeated explicit handling; session scope is not assumed to eliminate later requests.
- For Calculator test policy, `always`, another app, unknown operation, or mismatched request identity cannot be approved even through a forged dialog response.
- Request schemas, error messages, and metadata are untrusted text, not instructions or executable configuration.
- Logs/status contain outcome and routing diagnostics, not form answers, secrets, or unrestricted server data.

Use an injected UI test double for unit tests; then test actual Pi RPC request/response events. Mock tests alone do not establish T3 approval delivery.

## RPC/T3 fixture gate

A harmless local MCP fixture requests a non-secret enum/string form and then returns text plus a tiny generated image. It must not invoke the Mac or access personal data.

Exercise:

1. Human accepts, declines, and dismisses actual T3 dialogs.
2. Ignore a prompt until timeout; verify no acceptance is sent.
3. Cancel a tool while approval is queued/open; verify no stale response is released.
4. Reload/disconnect during a prompt; verify cleanup and explicit fresh connection initialization.
5. Verify native tool result `isError`, text, structured content, and image forwarding; visually confirm the image in T3 as a separate assertion.

Save evidence with exact Pi/T3 versions and host-hook revision. Never label the package compatible with T3 based solely on `ctx.hasUI === true` or a simulated RPC client.

## Live Computer Use gate

Requires renewed explicit test authorization and a compatible native host/package, not current Pi 1.1.0 alone.

- Use native MCP over the existing SSH transport and original OpenAI launcher.
- Restrict to Calculator and session-only approval; no OS permission edits.
- Read initial state and freshly derive element identifiers.
- Calculate `2 + 2`; confirm accessibility state displays 4.
- Capture a fresh screenshot and inspect it through Pi/T3.
- Record actual approval schema/metadata behavior in redacted fixtures without storing unrelated desktop data.
- Stop on approval/authentication failure; no alternative GUI automation backend.

## Retirement regression gate

Future coverage, outside the initial form-only slice: independent native/extension form and URL routing, additional negotiated protocol profiles, and other client features.

Run the same suite with a host-owned native implementation. Confirm the package stays inactive and does not mask native user settings. Remove feature code only after the documented minimum host version/contract makes it unnecessary. Keep regression fixtures useful to upstream Pi where possible.

## Repository integration gate (when code is added)

- Follow repository AGENTS.md and README.md; package-local check/test scripts remain authoritative.
- Reserve package resource directories; expose only public extension entry points.
- Keep experimental package out of root autoload extensions.
- Refresh both npm and pnpm lockfiles for dependency changes; no implicit global installation or update.
- Run package checks, deterministic tests, canonical `./scripts/check.sh`, packaging/load tests, and supported package-manager CI layouts.
- No live Mac interaction or external credentials in default CI.
