# Live suite

Ten checks that drive the real `pi` binary with this extension loaded, against the real
Claude Code and your Claude plan. The unit tests in `test/*.test.ts` script a fake Claude Code
and cannot notice when the real one changes; this suite can. Run it by hand before a release.
It is not part of `npm test` (that runs `test/*.test.ts`, which does not reach this directory).

```sh
npm run test:live          # tsx --test test/live/*.live.ts
# Repeat against the other current models:
CS_LIVE_MODEL=claude-subscription/claude-sonnet-5-5 npm run test:live
CS_LIVE_MODEL=claude-subscription/claude-opus-5-5 npm run test:live
```

## What it needs

- `pi` on PATH (Pi 1.3.0 or newer, as this package requires). Set `PI_BIN` to
  use a particular binary. When run through `npm run`, the workspace's `node_modules/.bin` is
  first on PATH and holds the Pi this package is typechecked against; the suite skips that
  directory, so `pi` means the one installed on your machine.
- Claude Code signed in with a Claude subscription (`claude auth login`), or
  `CLAUDE_CODE_OAUTH_TOKEN` set. With neither, or without `pi`, the suite reports itself as
  skipped with the reason and exits 0.
- Network access. Node 22+.

Each test gets a fresh temporary project directory and Pi configuration directory
(`PI_CODING_AGENT_DIR`), removed afterwards, so your Pi settings, sessions, skills and
extensions are neither read nor changed. The child Pi's environment loses every `CLAUDE*`
and `ANTHROPIC*` variable except `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN`.

## What it costs

About 13 Haiku 5.5 requests in all, each a few thousand mostly cached tokens, with prompts of
one or two lines: a plain answer (1), a tool turn (2), two parallel tools (2), two prompts in
one process (2), an aborted answer and a follow-up (2), a saved session and its continuation
(2), a thinking answer (1) and a plan-limit check (1). Listing models and the unknown-model
failure send none. Claude Code may add a small housekeeping request of its own (a session
title) for each process it starts, so budget for roughly twenty. It takes about 30 seconds and
barely moves the plan's five-hour window (a Max plan showed 15% to 17% across several runs, shared with other use). Nothing is billed per token to Pi;
requests count against your plan limits.

## What it checks

1. A plain prompt: text answer, stop reason `stop`, non-zero token usage and an API
   list-price estimate. This estimate does not establish how Anthropic billed the request.
2. A file read: Pi runs its own `read` tool, the answer holds the file's content, and one
   Claude Code process served both requests of the turn.
3. Two `read` calls in one assistant message both run and both results are used.
4. A second prompt in the same Pi process continues the same Claude Code process and
   remembers the first exchange.
5. Aborting mid-answer ends the turn as aborted, and the next prompt works.
6. A session file continued by a new Pi process (`--session-dir`, `-c`) recalls a fact from
   before the restart.
7. `--thinking high` succeeds. Whether a thinking block came back is printed, not asserted.
8. A `rate_limit_event` arrives during a turn with a utilization figure for each window.
9. `pi --list-models claude-subscription` lists models that all have a context window and an
   output limit.
10. An unknown model id exits non-zero with a message naming it, quickly.

"One Claude Code process" is read from the SDK's `system`/`init` messages, which
`record-sdk-messages.ts` (loaded into Pi with `-e`) writes out from `provider_stream_event`:
the number of distinct `session_id` values is the number of Claude Code processes.

## Reading a failure

Answers are checked for a distinctive token the prompt supplies (a made-up word in a file,
a number), never for wording. Test 3 asks Haiku to make two calls together; if it ever makes
them one after the other the test fails with the number of calls per message, and that is
the model, not the package. Anything else that fails is worth a look.
