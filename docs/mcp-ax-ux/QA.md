# MCP AX/UX experiment: tmux QA

Worktree branch: `experiment/mcp-ax-ux`. Manual checks used the real Pi **0.87.1** TUI in tmux, with the worktree extension, a deterministic offline provider and a local stdio fixture server. No paid completions, external MCP services, personal auth files or real credentials were used.

## Reproduce

From the repository root, with package dependencies installed and `pi`/`tmux` available:

```sh
tmux new-session -s mcp-demo -x 110 -y 36 './packages/mcp-client/scripts/tui-demo.sh'
```

For fullscreen:

```sh
tmux new-session -s mcp-demo-fullscreen -x 48 -y 24 './packages/mcp-client/scripts/tui-demo.sh --tui-mode fullscreen'
```

The launcher prints its temporary fixture directory. In another terminal, write `slow`, `fast` or `rejected` to that directory's `mode` file. `slow` delays connection setup and tool discovery by five seconds each; `rejected` adds an invalid tool definition. Use `/reload` for connection setup and `/mcp refresh` for discovery. The launcher removes the directory on exit. Its deliberate `--no-approve` flag may show Pi's project-trust notice; it does not use project MCP configuration.

Provider inputs are scripted, not interpreted by an LLM:

- `slow`: eight-second tool call with a server progress message after three seconds; Ctrl+O expands arguments.
- `form`: request scalar preferences through MCP elicitation.
- `fail`: fixture RPC error, with no external operation.

`/mcp prompt`, `/mcp subscribe demo` and `/mcp unsubscribe demo` exercise the real command handlers. `/quit` exits.

## Observed results

| Scenario                      | Result                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Missing executable            | Persistent unavailable health warning; status explains missing executable and `/reload`.                                     |
| Slow connection and discovery | Delayed native activity status appears, then clears when finished. No persistent healthy-state counter.                      |
| Explicit slow refresh         | Activity shows `refreshing tools`; transcript reports per-server outcome; transient status clears.                           |
| Slow tool call                | `awaiting result` appears after two seconds; numeric progress and server message replace it; final result replaces progress. |
| Expanded call                 | Labelled arguments preserve explicit `false`; nested fixture token is redacted while custom renderer is active.              |
| Form validation               | Out-of-range integer rejected with a field-specific error; corrected value accepted.                                         |
| Guided form                   | Enum choice, boolean `false` and skipped optional field survive correctly; review requires `Send answers`.                   |
| Cancel form                   | Escape during entry returns `{ "action": "cancel" }`, not partial answers.                                                   |
| Prompt picker                 | Server/prompt selection, required argument and optional skip lead to a review; cancellation queues nothing.                  |
| Resource subscriptions        | URI entry plus confirmation subscribes; recorded-subscription picker plus confirmation unsubscribes.                         |
| Rejected definition           | One exclusion notice; partial catalog and reason visible in status; recovery clears health warning.                          |
| RPC failure                   | Call result warns execution outcome is unknown, preserves server diagnostic and does not retry.                              |
| Layout                        | Checked regular and fullscreen, 110 columns and 48 columns; narrow inputs/selection instructions wrap and remain usable.     |
| Launcher                      | Isolated demo script starts successfully with the scripted provider.                                                         |

Automated regressions additionally cover headless refusal, abort before answer release, finite-number validation, bounded retries, schema fallback, shared dialog behaviour, command cancellation, activity aggregation and shutdown cleanup.

### Captures

These are **actual tmux text viewport captures**, not graphical screenshots. They do not demonstrate colour fidelity. All values are fixture data.

- [Startup wait](captures/startup.txt)
- [Refresh wait](captures/refresh-wait.txt)
- [Field validation](captures/form-validation.txt)
- [Review before release](captures/form-review.txt)
- [Fullscreen narrow form](captures/fullscreen-narrow-form.txt)
- [Fullscreen narrow refresh](captures/fullscreen-narrow-refresh.txt)

## Known Pi reload limitation — not fixed here

On Pi 0.87.1, old dynamically registered MCP calls lose their custom renderer after `/reload`. New calls still use it. This is **also a display-redaction limitation**: Pi's generic fallback can show raw historical arguments, including the fixture-only token `fixture-secret` in [this capture](captures/reload-limitation.txt). Never treat preview redaction as a security boundary; arguments remain in the session/wire data regardless.

Minimal observed reproduction: run `fail`, verify `demo • fail`, run `/reload`, and observe `mcp_demo_fail_718f59d1258d887b`. Repeating with `slow` demonstrates fallback argument rendering. A capture assertion for the friendly header passed before reload and failed after reload.

The inspected Pi 0.87.1 implementation supports a lifecycle-order explanation: `InteractiveMode.handleReloadCommand()` passes `restoreChatBeforeSessionStart` to `session.reload()`. That callback rebuilds transcript components **before** MCP tool discovery in `session_start`; `ToolExecutionComponent` retains the tool definition supplied to its constructor. The public UI API does not provide a way for this extension to replace those historical components' definitions.

A proper regression/fix belongs at Pi's dynamic-registration/transcript-replay boundary. This experiment does not start servers during extension factory loading, cache stale executable tool schemas, monkey-patch Pi internals, or rewrite session history to disguise the problem.

## Still outside this pass

- Arbitrary JSON-schema form widgets (nested arrays/objects, composition, remote references); advanced JSON remains the fallback.
- Full accessibility review, graphical colour/theme verification and a real RPC frontend usability pass. RPC-compatible native dialog/status methods are used, and noninteractive behaviour is covered by tests.
- Live-server authorisation/sampling UX; unchanged opt-in approval boundaries remain in place.
