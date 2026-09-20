# subagents

Persistent Pi RPC children, supervised by a manager inside the parent Pi process. Children retain their conversations after finishing work; close them explicitly when no longer needed.

## Install

```bash
pi install ./subagents
```

Reload the parent (manually or using `self_reload`). Tested with Pi 0.85.1, Node 22+, and Linux. TUI and RPC parents are supported; print/JSON parents are not.

## Tools

| Tool | Purpose |
|---|---|
| `subagent_spawn` | Start a child and send its initial task; returns prompt acceptance, not task completion |
| `subagent_list` | Status, resolved model/thinking, unread counts, usage and session/log paths |
| `subagent_send` | Prompt an idle child, or steer/queue a follow-up for a working child |
| `subagent_read` | Read new output, or replay from an explicit cursor |
| `subagent_wait` | Wait for any/all selected children; at most 60 seconds per call |
| `subagent_abort` | Clear queues and cancel work without closing the child |
| `subagent_close` | Abort and stop the child; retain its saved conversation |
| `subagent_resume` | Restart a stopped child and optionally prompt it |
| `subagent_respond` | Answer an extension UI request by ID; human-required approvals remain human decisions |

Example spawn:

```json
{
  "name": "reviewer",
  "task": "Review src/auth.ts for correctness. Do not modify files. Report findings with file/line references.",
  "cwd": "/absolute/path/to/project",
  "model": "openai-codex/gpt-5.6-luna:medium",
  "tools": ["read", "grep", "find", "ls"]
}
```

`subagent_send` accepts `behavior: "steer"` or `"followUp"` when the child is working. Steering is delivered at a tool boundary, not as a hard interrupt. Use `subagent_abort` for cancellation.

A finished child remains idle. In `subagent_wait`, idle, failed, and stopped children qualify as settled; `any` can therefore return immediately when selecting a previously idle child. Pending extension dialogs also return early so they can be addressed. Cancelling a wait does **not** cancel child work.

`subagent_read` advances a persistent cursor by default. Supplying `since` reads without advancing it. The manager retains the last 100 updates, each at most 12,000 characters, and returns about 24,000 characters per read. A cursor gap is reported explicitly. Tool results are capped at 30KB/1000 lines, with overflow saved to a private result file.

## Spawn control

V1 intentionally exposes broad control:

- `cwd`, `model` (including `:thinking`), explicit `thinking`, and built-in/extension `tools` allowlist. An empty tools array disables all tools.
- `executable` (default `pi` on PATH), `executableArgs` (e.g. a CLI JS path for `node`), and additional `cliArgs`.
- `env`: overrides merged into the inherited environment. Overrides are **not persisted**; supply them again on resume. Never put credentials in CLI arguments, task text, or other persisted fields.
- `inheritExtensions`: false by default. Explicit `-e` entries in `cliArgs` can load selected extensions even with discovery disabled.

RPC mode and the unique managed session file are owned by the manager. Conflicting mode/session flags, print/export modes, and `--` are rejected. Send prompts through the task/message fields, not positional CLI arguments. Other Pi flags, including system prompts, context/skill settings, provider selection and one-run project trust, remain available through `cliArgs`. The actual resolved model and thinking level are returned after startup. Prefer a provider-qualified model when you know the provider: Pi's short-name matching can select another provider's similarly named model (for example, an OpenRouter batch variant rather than OpenAI Codex).

No parent conversation is copied automatically. Children load context files, skills and settings according to normal Pi CLI behavior and project trust unless overridden. Parent extensions are **not** blindly inherited. `PI_SUBAGENT=1` marks children; this extension declines to register its tools inside a marked child, even if explicitly loaded. This is an accidental-recursion guard, not a security boundary.

The default limit is **four live processes**, including idle children. Configure `PI_SUBAGENTS_MAX_CHILDREN` before starting the parent to change it. Close idle children to release slots.

## Reports and user controls

Completion, failure, and extension input requests produce attributed custom messages in the parent. They are queued as follow-ups while the parent is working and can trigger a parent turn when idle. Child reports are delegated work output, **not user instructions or permission grants**. Routine streaming/tool chatter stays in logs rather than flooding parent context.

In the TUI, a lowercase `subagents` summary uses the theme's `dim` color and sits on the right of the directory/branch row, directly above the model display. If the directory and summary cannot fit together, the summary gets its own right-aligned row above the model. RPC clients still receive a normal status entry.

Implementation note: `src/footer.ts` decorates the actual exported `FooterComponent.prototype.render` rather than copying Pi's footer or inventing an `AgentSession` adapter. This is a process-wide compatibility hook for Pi's single interactive UI, **not a supported footer-decoration API**. It preserves all stock rows except adding to the first, follows upstream renderer changes, and restores the original renderer on shutdown/reload. It still assumes the stock first row is the directory and the second contains the model; major layout changes need rechecking. Completely custom footers that do not use `FooterComponent` are unaffected and will not show this decoration.

User commands:

```text
/subagents
/subagents abort <id>
/subagents close <id>
/subagents close-all
```

Children can ask ordinary questions by ending their response; the parent answers with `subagent_send`. Extensions using RPC dialogs appear in `subagent_read.uiRequests` and can be answered or cancelled through `subagent_respond`. Timed dialogs may expire on the child before the parent responds. TUI-only custom extension interfaces do not work in RPC.

## Persistence and shutdown

State is stored under:

```text
<pi-agent-dir>/subagents/<parent-session-id>/
  registry.json
  subagent-<id>.session.jsonl
  subagent-<id>.events.jsonl
  subagent-<id>.stderr.log
```

Directories are private (0700); manager-written files are 0600. Logs and sessions may contain sensitive task/code/tool data. Raw event and stderr logs are each capped at 20 MiB; the final record may be truncated at that limit. Saved Pi session history remains the authoritative conversation. There is no automatic retention/deletion policy yet.

On reload, session replacement, or normal exit, the extension clears queues, requests abort, then sends SIGTERM with bounded SIGKILL fallback. POSIX children have their own process groups. After reload, saved entries are marked stopped and must be explicitly resumed. Interrupted tasks are **not** automatically replayed. Files already modified are not rolled back.

V1 does not reconnect to live processes after a parent crash/SIGKILL. Such an abrupt death can leave orphan processes; inspect and stop them before resuming their sessions. Do not open the same parent session in multiple concurrent parent processes; the registry is not a multi-process database. Background daemons deliberately launched by children are not guaranteed to be cleaned up.

A failed model run can leave a live, usable child (`failed` with a PID); send a corrected prompt or close it. A failed/dead process has no PID and must be resumed. RPC timeout errors mean acceptance may be unknown: inspect status/output before retrying a prompt.

## Safety and scope

These are ordinary subprocesses with inherited user privileges and credentials, **not sandboxes**. Even a tools allowlist is not isolation when it includes unrestricted bash. The parent must coordinate file ownership or use separate worktrees for parallel edits. No peer communication, workflow runner, automatic worktree management, or independent manager daemon is included in v1.

## Development

```bash
cd subagents
npm ci --ignore-scripts
npm run check
npm test
```

Tests cover strict LF JSONL framing (including Unicode separators), parallel work, incremental cursors, follow-ups, cancellation, process cleanup, registry recovery, UI requests, failures, concurrency, environment non-persistence, and real Pi RPC lifecycle/resumption using a deterministic local provider. Automated tests require no real model calls. Live smoke tests can use `gpt-5.6-luna:medium`.
