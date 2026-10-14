# t3-subagents live smoke test

**Historical:** the `t3-subagents` package was removed on 2026-10-14; see [the revamp note](t3-subagents-revamp.md).

**Passed:** 2026-10-06, 23:25:32–23:26:01 UTC.

This supplements the [research and implementation note](t3-code-subagents-integration.md)
and the automated offline RPC fixtures in `t3-subagents`.

## Setup

- Installed bundled Pi **1.0.3**; a private RPC session and agent directory in the
  integration worktree's ignored `.pi/worktrees/t3-subagents-live-smoke/`.
- The unchanged installed T3 injected bridge,
  `~/.t3/caches/pi-t3-mcp-extension.ts`, SHA-256
  `ee4ccd63dae4d84ee21cf7f41859e755c3e8ec09577d8682e13162eba0b15b3b`.
- Updated native extension loaded with `--disable-native-subagents`, plus the
  new wrapper. No native tools, commands or manager directory appeared.
- A deterministic local provider drove the wrapper tools; it did **not** mock
  MCP responses. Two real T3-owned tasks used the live catalog's Codex
  `gpt-6-sol` target with `reasoningEffort: low`.
- The controlled test host explicitly loaded only these test extensions.
  Its isolation flags are not normal T3 launch recommendations.

No T3 settings, global Pi configuration, Allowlists or main-checkout files were
changed. The package was not activated in the user's normal T3 launch.

## Observed results

| Check | Result |
| --- | --- |
| Live catalog | Providers, model/options and delegation/cancellation features decoded through the registered bridge. |
| Async delegation | Returned saved T3 task/thread/run identities with running/working state. |
| Accepted-request replay | Same identity returned without another backend delegation. |
| Local list | Saved accepted identity present; no backend read. |
| Unsupported composition | Extra `tools` field rejected before backend dispatch. |
| T3 completion delivery | Notification arrived in the original parent T3 thread, not from a native Pi report. |
| Restart/recovery | A new Pi process reopened the saved session and replayed acceptance without redispatch. |
| Terminal result read | `completed`, `result_available`, exact summary `T3_SUBAGENTS_LIVE_SMOKE_OK`. |
| Active cancellation | Running/working second task received `cancel_requested`; T3 run and wrapper read confirmed `interrupted` / `result_available`. |
| Cancellation replay | Cached receipt replayed without another stop, both before and after restart. |
| Execution boundary | Real namespaced MCP calls had nested tool-call IDs attributed to their wrapper calls. |
| Native wake suppression | No `subagent-report` in the isolated host. |

Across both processes, observed backend tool calls were exactly:

- 1 `orchestrator_capabilities`
- 2 `delegate_task`
- 3 `task_status`
- 1 `task_cancel`

The private local evidence is `.pi/worktrees/t3-subagents-live-smoke/evidence.json`,
with the saved session alongside it. The harness and evidence are ignored test
artifacts, not CI tests or package resources. No bearer credential was persisted.

## Initial smoke limits

This initial test was a full-access live smoke test, not supervised-mode approval certification.
T3's notification was observed during an active parent turn; a separate idle
parent wake was not exercised. Cancellation was tested on an original running
task with no later backing-thread work or descendants; it does not establish
terminal-task cancellation scope or detached-process cleanup.

No uncertain transport failure, expired server cache or lost-history recovery was
induced. Cached replay proves this wrapper's local non-redispatch behavior, not
global exactly-once execution. Cached acceptance/stop receipts remained stale
metadata; fresh reads established the final statuses.

The two smoke tasks reached terminal states. No implementation fix was required.

## Additional validation — 2026-10-07

- **Post-admission reply loss and malformed replies:** injected at the registered
  tool-result boundary after real T3 admission. Both remained uncertain; a new
  Pi process recovered each using the unchanged brief/key and received the
  original task identity. Accepted replay and changed-key checks made no extra
  dispatches. Both real tasks completed with `T3_FAULT_SMOKE_OK`.
- **Caller abort:** blocked the nested call before backend admission and aborted
  through real Pi RPC. The caller signal propagated, intent remained uncertain,
  and an unchanged retry admitted one task, completing with
  `T3_ABORT_RECOVERY_OK`.
- **Deadline/cache-reset simulation:** deterministic package tests cover a
  timeout-shaped transport failure, accepted local replay without querying an
  expired server cache, and the documented lost-history/server-reset limitation.
  These are simulations, not a claim of actual deployed cache expiry or a global
  exactly-once guarantee.
- **Descendant cancellation scope:** while a parent and its T3-owned grandchild
  were live, wrapper cancellation interrupted the parent. The grandchild remained
  running and required a separate explicit thread interruption for cleanup.
  Root task-status access to a grandchild is correctly rejected by T3's direct
  ownership scope; its independent run was checked through thread state.
- **Terminal-task cancellation with later work:** the original published task
  was completed while a second backing-thread run was live. Cancellation returned
  `completed`, not `cancel_requested`, and the later run subsequently completed
  normally. The original published summary remained unchanged. A regression test
  covers this receipt variant and cached replay without storing summaries.
- **Idle-parent delivery:** the original assistant turn ended after admission of
  a delayed read-only task. T3's completion notification initiated a new parent
  turn; a fresh RPC host reopened the session and read `completed` /
  `result_available` with `T3_IDLE_WAKE_SMOKE_OK`. No local scheduler or native
  `subagent-report` was involved.
- **Genuine supervised-mode approval:** **passed** in an actual T3-owned Pi
  task using `approval-required`. The human declined the first wrapper call,
  then approved the second wrapper call and its nested MCP call. T3's timeline
  records the declined tool result and all three completed approval requests.
  The private trace shows one successful nested catalog request attributed to
  the wrapper; the live catalog reports `runtimeMode: approval-required`.
  No model or harness manufactured approval. The task completed with
  `APPROVAL_SMOKE_OK`.

The installed deployment demonstrated task-only cancellation in these cases;
the broader audited upstream implementation still makes cancellation scope
version-dependent. Early test-harness errors (receipt-regex escaping, a
direct-ownership query, and an overly short test window) were corrected without
changing implementation code or hiding failed attempts. Package checks currently
pass **13 tests**. Final clean-install root gates passed with npm and pnpm;
bundled Pi 1.0.3 also passed the live RPC paths. All requested validation gates
are complete within the limits stated above. The test tasks reached terminal
states; the deliberately surviving descendant was explicitly interrupted.
No implementation fix was required.
