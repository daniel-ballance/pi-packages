# self-reload

Let a Pi agent reload its own runtime and continue working, without asking you to type `/reload` each time.

## Install

The [root package](../../README.md#install-from-github) includes self-reload. To install it alone from this repository:

```bash
pi install ./packages/self-reload
```

Run `/reload` **once in an already-running session** to discover the package. Future sessions load it automatically. Local installation references this directory directly, so subsequent edits are picked up on reload.

Requires Pi 1.3.0+, and interactive (TUI) or RPC mode; print/JSON invocations are intentionally rejected by the tool.

## Usage

Ask Pi to edit an extension, check it, then use `self_reload`:

```json
{
  "reason": "Activate the updated tool renderer",
  "expectedTools": ["my_tool"],
  "continuation": "Call my_tool and verify its new behavior."
}
```

The tool must be called **alone**, after saving files and running checks. Inspect active subagents and workflows first and plan their recovery. Calling alone is an agent contract, not a runtime-enforced batching restriction.

`reason` and `expectedTools` are optional; existing continuation-only calls still work. Expected names are checked against **active** tools, so registered but inactive tools are reported as unavailable.

The tool returns `status: "queued"` and requests termination of the current agent run. In the TUI, the tool header explains the reason, its result warns about process impact, and a temporary status covers waiting for idle. Pi's native banner owns reload progress—there is no duplicate reload notification. Direct commands retain an impact warning because they have no tool result. RPC clients receive explicit reload notifications and progress statuses. A fresh-runtime message starts the next run with the supplied instruction and reports `status: "reloaded"` plus any `missingTools`. **Queued → reloaded → behavior verified are separate stages.** The agent must perform and report behavior verification; this extension never claims it happened.

Collapsed tool calls show a short reason (or continuation); expanded calls expose the complete continuation and expected tool names. RPC clients receive status/notification events and structured completion details even though they do not use the TUI renderer.

You can also invoke the extension command directly:

```text
/self-reload Verify the updated tools and continue testing.
```

This reloads extensions, skills, prompt templates, themes, and context files using the same `ctx.reload()` flow as Pi's built-in `/reload`. It does not restart Pi or clear the conversation. No startup hook automatically reloads anything.

## How it works

1. The tool stores the request in the current instance and sends `/self-reload request:<id>` with explicit extension-command dispatch enabled (`expandPromptTemplates: true`). The opaque token keeps metadata and multi-line continuations out of command parsing and prevents duplicate queued requests.
2. The command waits for the agent to become idle, then calls `ctx.reload()`. The tool does **not** await this command, avoiding a wait-for-self deadlock.
3. Reload shuts down the old extension instance and loads a new one.
4. After `ctx.reload()` returns, the old command emits a plain-data completion signal through a namespaced process-local event. A listener owned by the **new** instance sends the confirmation and continuation to Pi.

The process-local bridge is deliberate: the old `pi`, command context, and even `pi.events` become stale after reload. Listeners are scoped by session ID and removed on `session_shutdown`. No sockets, background processes, timers, or persistent continuation files are needed.

## Limits and recovery

- Reload executes **all extension shutdown hooks**. Extension-owned processes and connections may close. In this repository, subagent processes stop and workflow execution stops; inspect saved state and use explicit recovery rather than assuming work resumed.
- “Reload complete” means the reload returned and the new self-reload instance is active. Pi may report individual extension load failures without rejecting the entire reload; verify expected tools and behavior separately.
- Keep this helper separate from experimental extensions. If you break or remove `self-reload` itself, automatic continuation may be unavailable. Fix it with ordinary file tools and use manual `/reload` or restart.
- A process crash/restart does not replay a pending continuation. The normal saved conversation remains available unless using `--no-session`.
- A reload exception produces a visible `status: "failed"` message and recovery turn when a same-session listener survives. It never automatically retries or executes the intended continuation as though reload succeeded. If no listener survives, Pi's extension-command error handling provides manual recovery instructions. A hung shutdown hook has no timeout or cancellation mechanism here.
- Continuation is a model turn and incurs normal usage. This is not a general-purpose slash-command execution tool.

## Development

```bash
cd packages/self-reload
npm ci --ignore-scripts
npm run check
npm test
```

Tests cover dispatch options, mode checks, idle handoff, stale-runtime avoidance, session isolation, failure/duplicate handling, missing replacement recovery, expected-tool checks, expanded rendering, and a real RPC subprocess using a deterministic local provider. The RPC test edits a loaded provider from v1 to v2 and verifies that the tool-triggered reload automatically continues with v2, then reloads again to check listener cleanup. Tests use isolated configuration and no provider network calls or real credentials.
