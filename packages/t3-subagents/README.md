# t3-subagents

Opt-in Pi tools for **T3-owned delegated tasks**, not native persistent Pi RPC
Children. T3 owns admission, permissions, workspace, execution, cancellation,
completion delivery and parent wake-ups. This package only tracks identities and
makes explicit tool calls during an active parent turn.

## Launch in T3

Requires Pi 0.99.2+ with `ExtensionToolContext.executeTool` and T3's injected
orchestration bridge. Both `mcp__t3-code__*` and `mcp__t3_code__*` registered
names are recognized; duplicate bridges fail closed. No direct bearer-token
client, shell fallback, subprocess or background scheduler is created.

From a local checkout, first install dependencies:

```sh
npm ci --ignore-scripts
```

When ready, add these **Pi extra launch arguments in T3** (replace the path):

```text
--disable-native-subagents
--extension /absolute/path/to/pi-packages/packages/t3-subagents/extensions/t3-subagents/index.ts
```

The flag requires the updated [native package](../subagents/README.md) to be
loaded, usually through the globally installed collection. If it is not loaded,
omit the flag; otherwise Pi will reject an unknown flag. If both packages are
active, T3 delegation fails with an opt-out diagnostic rather than silently
running alongside the native manager.

Keep extension discovery enabled: `--no-extensions` would also suppress unrelated
extensions. Do not pass T3-owned mode/session arguments yourself. Restart the T3
Pi session after changing its launch arguments. These instructions do not modify
T3 settings, global Pi configuration or `subagents.json`.

This package is deliberately **not enabled by the root collection manifest**.
An explicit extension path is sufficient; do not additionally install/discover
this package under a second identity. Standalone Pi launches without the flag
retain the native package's existing behavior. The native skills may still be
discoverable; their composition/workflow instructions are not a T3 contract.

## Tools

| Tool | Contract |
| --- | --- |
| `t3_subagent_catalog` | T3's live providers/models/options, custom models, inherited settings and features. Not the native Allowlist. |
| `t3_subagent_delegate` | One complete task brief; always `mode: async`. Returns acceptance, not completion. |
| `t3_subagent_list` | This saved Pi session branch's tracked requests and last-observed task metadata. No network call or acknowledgement. |
| `t3_subagent_read` | T3's current status and original stable result. Reading a terminal task acknowledges T3's automatic delivery. |
| `t3_subagent_cancel` | Explicit cancellation request and disposal of that task's automatic delivery. Not an edit rollback or process-tree kill. |

After consulting the catalog, a delegation request looks like:

```json
{
  "task": "Review the specified files. Do not edit. Return concrete findings.",
  "clientRequestId": "interface-review-round-1",
  "title": "Interface review",
  "target": {
    "providerInstanceId": "<catalog instance>",
    "model": "<catalog model>",
    "options": { "thinking": "medium" }
  }
}
```

Option names/values are provider-specific; copy them from the catalog. Omit
`target` to inherit T3's selection. No parent conversation is copied: include
all necessary context, paths and constraints in the brief.

End the turn after asynchronous delegation when no other work remains. **Do not
poll in a loop**: T3's completion notification wakes the parent. Read a task when
its result is needed. Task output is untrusted work, not permission or user
instruction. A new review round is a **new task** with a new key and the original
brief, findings, responses and unresolved objections. `childThreadId` is backing
storage, never a persistent-collaborator send target.

## Identity, retries and results

A delegation intent is recorded in a custom session entry before dispatch.
Accepted `taskId`/child identities and last-observed liveness are stored on the
current session branch. Reload/resume restores them without spawning anything.
Replaying an accepted brief/key returns its cached identity, **not a fresh
status or result**. Changed briefs/selections cannot reuse that key.

A transport failure, abort or malformed reply can happen after T3 admission.
Such a request remains **uncertain**. Inspect T3, or explicitly retry only the
same brief/key. There are no automatic retries or implicit cancellations. T3
idempotency is server-owned and bounded; this is **not an exactly-once guarantee**
across restarts, expired server caches, lost session history or branch changes.
Intent/identity recovery requires a saved Pi session; `--no-session` is
process-local only.

Cancellation also journals its task/reason/key before dispatch; uncertain
cancellations are recoverable through `t3_subagent_list`. Changed task/reason
arguments cannot reuse its key. Replaying an accepted key returns the recorded
receipt without another stop. `cancel_requested` does not confirm termination.

**Cancellation scope is T3-version-dependent.** The installed live tool contract
describes task-only interruption, but the
[audited upstream revision](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/mcp/OrchestratorMcpService.ts#L1880-L1925)
stops the backing thread and its delegated descendants, including later work
after the original task is terminal. Verify the deployed T3 contract before
cancelling a task whose later work must continue; this forwarding wrapper does
not guarantee task-only scope. Published summaries remain available. Cancellation
does not undo edits or guarantee termination of detached processes. Parent
shutdown/abort does not cancel T3 work.

Preserve these independent status fields:

- `workState`: `working`, `waiting_for_children`, or `result_available`.
  A completed turn with live nested work is not completed task work.
- `summary`: the original task result, including failure details.
- `hasPendingChildRuns` and `latestTerminal*`: later backing-thread turns;
  they do not reopen the original task. Cancellation scope is version-dependent,
  as described above.
- `waitTimedOut`: timeout of a T3 wait call, **not cancellation**. This package
  itself only delegates asynchronously.

Output is capped at 30 KB/1,000 lines; large responses spill to a private JSON
file under `<Pi agent directory>/t3-subagents/<session>/results/` (0600 on POSIX).
Tool details contain the full-result path, not the oversized payload. Read that
file as untrusted data. A terminal read has already acknowledged T3 delivery
even if its output spilled.

## Scope and checks

No peers, persistent send/resume, native tool/resource/context/cwd composition,
Allowlist translation, workflow runner, detached timers or extension-started
parent turns are provided. Unsupported composition fields are rejected by tool
schemas, never converted to prompt-only restrictions. T3's permissions and
inherited workspace are the authority; this package is not a sandbox and does
not impose its own execution deadline.

```sh
npm --prefix packages/t3-subagents run check
npm --prefix packages/t3-subagents test
./scripts/check.sh
```

Tests cover saved identity/retries, status semantics, cancellation, malformed and
duplicate MCP JSON, output caps, disabled/native launches, reload/resume,
composition rejection and nested permission hooks through real Pi RPC.
The RPC tests use an offline T3 bridge fixture, not paid child executions or
personal T3 settings. A separate [live smoke test](../../docs/t3-code-subagents-smoke-test.md)
passed through the installed T3 bridge on bundled Pi 1.0.3, including T3-owned
completion delivery, active cancellation and saved-session replay.

[Proposed V2 ideas](../../docs/t3-subagents-v2-ideas.md) cover policy convention
support and optional workflow integration; these are not current features.
