# self-reload

Let a Pi agent reload its own runtime and continue working, without asking you to type `/reload` each time.

## Install

From this repository:

```bash
pi install ./self-reload
```

Run `/reload` **once in an already-running session** to discover the package. Future sessions load it automatically. Local installation references this directory directly, so subsequent edits are picked up on reload.

Tested with Pi 0.85.1. Requires interactive (TUI) or RPC mode; print/JSON invocations are intentionally rejected by the tool.

## Usage

Ask Pi to edit an extension, check it, then use `self_reload`:

```json
{"continuation":"Call the updated tool and verify its new behavior."}
```

The tool must be called **alone**, after saving files and running checks. It returns `status: "queued"` and requests termination of the current agent run. A fresh-runtime completion message starts the next run with the supplied instruction.

You can also invoke the extension command directly:

```text
/self-reload Verify the updated tools and continue testing.
```

This reloads extensions, skills, prompt templates, themes, and context files using the same `ctx.reload()` flow as Pi's built-in `/reload`. It does not restart Pi or clear the conversation. No startup hook automatically reloads anything.

## How it works

1. The tool sends `/self-reload …` with explicit extension-command dispatch enabled (`expandPromptTemplates: true`).
2. The command waits for the agent to become idle, then calls `ctx.reload()`. The tool does **not** await this command, avoiding a wait-for-self deadlock.
3. Reload shuts down the old extension instance and loads a new one.
4. After `ctx.reload()` returns, the old command emits a plain-data completion signal through a namespaced process-local event. A listener owned by the **new** instance sends the confirmation and continuation to Pi.

The process-local bridge is deliberate: the old `pi`, command context, and even `pi.events` become stale after reload. Listeners are scoped by session ID and removed on `session_shutdown`. No sockets, background processes, timers, or persistent continuation files are needed.

## Limits and recovery

- Reload executes **all extension shutdown hooks**. Extension-owned processes and connections may close. A future subagent manager must account for this.
- “Completed” means the reload returned and the new self-reload instance is active. Pi may report individual extension load failures without rejecting the entire reload; verify expected tools and behavior separately.
- Keep this helper separate from experimental extensions. If you break or remove `self-reload` itself, automatic continuation may be unavailable. Fix it with ordinary file tools and use manual `/reload` or restart.
- A process crash/restart does not replay a pending continuation. The normal saved conversation remains available unless using `--no-session`.
- A reload exception is surfaced through Pi's extension-command error handling; it does not produce a success message.
- Continuation is a model turn and incurs normal usage. This is not a general-purpose slash-command execution tool.

## Development

```bash
cd self-reload
npm ci --ignore-scripts
npm run check
npm test
```

Tests cover dispatch options, mode checks, idle handoff, stale-runtime avoidance, session isolation, failure/duplicate handling, and a real RPC subprocess using a deterministic local provider. The RPC test edits a loaded provider from v1 to v2 and verifies that the tool-triggered reload automatically continues with v2, then reloads again to check listener cleanup. Tests use isolated configuration and no provider network calls or real credentials.
