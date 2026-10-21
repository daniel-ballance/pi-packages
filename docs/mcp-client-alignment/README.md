# MCP client alignment — implementation status

## Direction

Evolve `packages/mcp-client` as an explicitly selected **replacement** for native
Pi MCP. Use native Pi 1.1.0 as the reference for host behavior, and the official
MCP specifications as wire authority. The earlier `mcp-additions` hook proposal
is [parked](../mcp-additions/README.md).

This includes the **second native-integration implementation pass**, not full native parity or MCP
conformance certification. Read [AUDIT.md](AUDIT.md) for the source-pinned
comparison, migration risks, and prioritized remaining work. Its original tables
are an audit snapshot; the dispositions below describe changes made afterward.

## Implemented and tested

| Change | Evidence |
| --- | --- |
| Guided and JSON forms require review, explicit send, and an edit/cancel route | `test/forms.test.ts`; three bounded review rounds, stale draft never released |
| Unknown elicitation modes fail closed | `test/forms.test.ts` |
| Cancellation checked after dialogs and before acceptance; obvious secret schemas/JSON keys rejected | `test/forms.test.ts`; heuristic protection, not exhaustive detection |
| Current URL elicitation no longer requires legacy `elicitationId` | `test/elicitation-version.test.ts`; uses actual negotiated-version callback, including MRTR consent/state/fresh-request-ID flow |
| Cancel/timeout of legacy tools/call, resources/read, prompts/get closes that connection and invalidates incoming approvals | `test/approval-lifetime.test.ts`; deliberately sacrifices concurrent connection work because legacy parent correlation is unavailable |
| Modern MRTR cancellation remains operation-scoped | `test/approval-lifetime.test.ts`; no late input-response retry; other operations remain usable |
| Idempotent peer close; no batch response after lifetime abort | `test/approval-lifetime.test.ts` |
| Legacy resultType/inputRequests stay data, not modern input/task control flow | `test/peer.test.ts` across four legacy revisions and registered-tool regression in `test/result-compatibility.test.ts` |
| Omitted content normalized to an empty array, allowing structured-only results like native Pi | `test/result-compatibility.test.ts`; explicit malformed fields rejected; output-schema validation retained |
| Direct image/error preservation and real stdio cancellation cleanup | `test/result-compatibility.test.ts`; local fixture process exits, tools deactivate, unknown-outcome diagnostic, no task accidentally persisted |

Reference behavior for result normalization was inspected in native
[Pi's client](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/mcp/src/client.ts).
The changes are local implementations; no upstream source files were vendored.
Preserve upstream license and source revision if a later change copies code.

### Native integration pass

- Explicit, read-only native config import; seconds-to-ms, enabled state, trusted
  overlays, extension registrations and hidden-tool rules preserved. Unsupported
  fields fail closed. `scripts/native-preflight.ts` can inspect explicit paths
  without opening connections or resolving credentials. Personal native config
  passed this check with the hidden module-directory tool retained.
- Native tool names/namespaces/annotations/exposure and full codemode MCP result
  envelopes; native resource routes, hidden-definition withdrawal, and embedded
  resource images. Top-level `_meta` is excluded from native model results.
- Serialized startup/session/server-registration reconciliation with startup
  aborts and bounded POSIX process-group cleanup. Linux wrapper/grandchild tests
  pass; escaped groups and other operating systems remain limitations.
- Strict Computer Use policy: exact app IDs, verified operation subset, human
  session grant followed by validated in-memory reuse, session-only response
  metadata, no generic fallback. Connection/recovery/branch changes revoke grants.
  It never grants authorization automatically or changes OS permissions.
- Complete losslessly escaped form-response review, bounded to 32 × 512-character
  pages, with sending available only after the final page.

### Review disposition

Independent core review found one defect: the tool adapter still interpreted a
legacy `resultType: "task"` after Peer correctly stopped interpreting modern
fields on legacy connections. Fixed with a negotiated-version gate and a
registered-tool regression proving ordinary presentation, output-schema
validation, and no saved task. A subsequent integrated review reported no
material new findings within its bounded scope and ran 48 focused tests.

The native integration review found queued reconciliation could restart after
shutdown and deferred exposure selected the wrong discovery tool. Generation
invalidation and builtin-specific codemode/tool-search activation fix those
issues, with registration/exposure/shutdown regressions. Follow-up independent
review ran 98 focused tests and reported no new material blockers.

## Verification actually run

Using the existing checkout/dependency layout, without installation or upgrades:

```sh
cd packages/mcp-client
npm run check
npm test
npm run format:check
cd ../..
./scripts/check.sh
```

- Package TypeScript check: passed.
- Full `mcp-client` suite after session-consent fixes: **223 passed**, zero failed/skipped.
- Package formatting: passed.
- Canonical repository gate: **passed**. Other packages' tests ran too; the
  `subagents` suite reported one skipped test. This is not a fresh two-manager CI
  matrix run or a dependency-install/lockfile validation.
- Evidence logs: `/tmp/mcp-client-alignment-tests.log` and
  `/tmp/pi-packages-mcp-alignment-root-check.log` (temporary, not durable artifacts).

The suite includes official SDK v1/v2 local transport fixtures. Additionally,
`scripts/native-rpc-smoke.mjs` passed against actual **Pi 1.0.3 and 1.1.0**
executables with isolated temporary HOME/config, a deterministic provider and
synthetic MCP servers. It verifies native names, hidden rejection, registered
servers, a simulated human session-only selection, resources, error envelopes
and image output through real codemode. No model API or Mac is involved.

Pi 1.1.0 was downloaded to `/tmp` only, not installed/upgraded, from the official
release; its archive SHA-256 matched GitHub asset metadata:
`3faa94666cd3849d37af320ff749407d0271b07a9b94f420c87e30866e10e289`.
RPC logs: `/tmp/mcp-native-rpc-smoke.log` and
`/tmp/mcp-native-rpc-smoke-1.1.0.log`. These prove RPC image blocks, not T3 visual
rendering or live signed-server approval interoperability.

## Remaining release gates

1. **Migration:** native-mode import avoids rewriting active native files.
   Broader native options and credential-store migration remain unsupported;
   reject them instead of dropping restrictions. Package-mode rollback still
   requires restoring native-format files before removing this package.
2. **Pi host parity:** expand dynamic registration, reload/resume and direct hook
   tests beyond the passing isolated native RPC scenario.
3. **Connection lifecycle:** late HTTP 404 after cancelled approval, additional
   recovery/disconnect ordering, and non-Linux process cleanup validation.
4. **Protocol depth:** clause-to-test mapping and negative cases for every claimed
   revision/transport/capability. Current protocol support paths are present but
   not exhaustive conformance evidence. Legacy URL-required/completion handling,
   actual browser isolation, version-error retry policy, and bounded dialog-queue
   behavior need follow-up. Do not widen deprecated features for checklist parity.
5. **Approval UX:** edit prefilling and dedicated titled-single/multi-select enum
   controls remain absent; those shapes use reviewed JSON. Secret-field detection
   has false positives/misses. Computer Use policy is implemented, but live scope
   and dialog interoperability still need separate verification.
6. **Broader live coverage:** the local fixture and supervised Calculator
   `2 + 2`/AX/screenshot/session-reuse scenario now pass through actual Pi/T3.
   Other apps, operating systems and authentication scenarios remain unverified.

## Operational state

Commit 9c221ef (2026-10-10) records these changes. When this record was written,
global installation and personal MCP files were unchanged.
The real T3 fixture test passed: the human selected session-only approval,
`{action: "accept", persistence: "session"}` arrived, and the visible fixture PNG
was forwarded through codemode (`/tmp/pi-codemode-7aee4d49623b2cec.png`).

The existing Mac server then connected as rmcp 1.5.0 / MCP 2025-11-25, preserving
the hidden module-directory tool and 120000 ms timeout. Two documented
`cua.getApp("com.apple.calculator")` attempts returned
`Computer Use server error -10005: cgWindowNotFound`. No arithmetic was entered;
no live AX result or screenshot was obtained. This is a concrete window-lookup
blocker, not evidence of Calculator E2E success or a diagnosed permission cause.
On the user-requested retry, Calculator selection succeeded and a fresh AX tree
and screenshot arrived (`/tmp/pi-codemode-c47bd5a640055c9a.jpg`). Calculator was
in unit-conversion mode. Opening View succeeded; selecting Convert was refused
with `Computer Use was not approved to use Calculator`. The agent stopped at
that refusal without bypass or further UI calls. Thus window lookup and live
image delivery were verified at that stage, but arithmetic was not yet verified;
the next attempt needed the corrected session-consent implementation. The user explicitly
reported they did not deny the request; the server error does not establish a
human denial.

### Session-consent defect identified

Read-only inspection of the installed server's `computer-use-policy.js` showed
it calls `createElicitation` before each operation and recognizes
`content.source === "computer-use-persisted-state"` for reused consent. The client
was sending session persistence but keeping no grant, so every operation prompted
again. Local inspected artifact SHA-256:
`8cd1272d7aa836479be6c3f4cc5b0b80526339eedd4852cbb6558f893f6721f8`.
The correction stores only explicit human grants in connection-local memory,
validates every subsequent request before reuse, revokes on lifecycle boundaries,
and exposes bounded approval diagnostics distinguishing explicit decline from
cancellation/timeout ambiguity. `/mcp revoke SERVER` clears client grants.
Independent review identified a multi-server branch-change ordering hole; all
grants now reset before any restoration await, covered by a two-server regression
with deliberately delayed unsubscribe. All 223 tests and the canonical root gate
pass. Both actual Pi 1.0.3 and 1.1.0 RPC smokes now require exactly one fixture
approval for repeated calls and verify the reused-consent marker. Logs:
`/tmp/mcp-consent-tests.log`, `/tmp/mcp-consent-root-check.log`, and
`/tmp/mcp-consent-rpc-{1.0.3,1.1.0}.log`. Live retest is staged with the same three
reversible project settings files. No server code or OS permission was changed.

### Successful live acceptance after consent correction

Calculator completed **2 + 2 = 4** through the replacement in actual Pi/T3 using
the existing signed server. Fresh full AX state recorded `Last Expression,
Value: 2 + 2` and `Edit field, Value: 4`; the fresh screenshot shows both.
The safe client history recorded exactly **one human approval plus 11 validated
session reuses**, spanning click, press_key and get_app_state; no repeated dialog.
Evidence is saved under `computer-use-mcp/evidence/calculator-session-consent.json`
and `.jpg`; the original screenshot is `/tmp/pi-codemode-ea72b5ff2678bfea.jpg`.
This closes the bounded Computer Use acceptance gate, not broader conformance.

Rollback removes only the three newly created `computer-use-mcp/.pi/` JSON files
(`settings.json`, `mcp.json`, `mcp-client.json`) and reloads native MCP. No OS
permissions, persistent app grants, or authentication settings were changed.
