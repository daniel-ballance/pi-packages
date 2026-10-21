# claude-subscription

A Pi provider that reaches Claude models through the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and the
Claude account Claude Code is signed in to.

The aim is that choosing one of these models feels like choosing the same model
on Pi's `anthropic` provider with an API key: Pi's tools, sessions, compaction,
thinking levels and commands all work as they do there. Claude Code is only the
transport, and its login is the only credential. Where the two still differ is
listed under [Compared with the `anthropic` provider](#compared-with-the-anthropic-provider).

## Read this first: how Anthropic bills it

Anthropic's [support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
says Agent SDK, `claude -p` and third-party app usage draw from subscription
limits. In practice the outcome depends on what the request contains.

Checked on 2026-10-13 with a Max plan and Agent SDK 0.3.296:

| Request sent through this provider | Anthropic's response |
|---|---|
| This package's own prompt (below) and Pi's tools | Accepted, counted against plan limits |
| Pi's stock system prompt | `400 Third-party apps now draw from your extra usage, not your plan limits.` |

So with Pi's default prompt, Anthropic treats the traffic as a third-party app
and bills it to **extra usage**, not plan limits. If extra usage is off for the
account, a request that still carries that prompt is rejected with that message,
which Pi shows as is.

This package does not send that default. When the selected model belongs to
this provider and you have not set your own prompt, it sets Pi's `customPrompt`
to a short text of its own. That is the option `SYSTEM.md` and
`--system-prompt` fill, so a prompt from either of those is sent as you wrote
it, and one that is Pi's default text can still draw the rejection above.
Everything else Pi puts in a prompt is still sent: its tool list, the rules
tools and extensions contribute, project context, skills, an appended prompt
and the working directory. Each request names this package to Anthropic as
`pi-claude-subscription/<version>`.

How Anthropic classifies a request is theirs to decide and may change. An error
from them reaches Pi unaltered.

### HTTP 400 when running Pi through T3 Code

If standalone Pi works but T3 returns `400 Third-party apps now draw from your
extra usage`, explicitly load this extension in T3's Pi provider **launch arguments**:

```text
--extension /absolute/path/to/pi-packages/packages/claude-subscription/extensions/claude-subscription/index.ts
```

Put it before other launch arguments and keep any existing arguments. T3 appends
its own extension afterwards. Name the same file that the installed package loads.
Pi then loads it once. `node scripts/root-package.mjs --t3-launch-args`, run from
that install, prints the argument. The p3stack
[T3 guide](../p3stack/docs/landing/t3-settings.md) gives the value for each
machine. Restart the affected Pi provider session so the new load order takes
effect; retry in a fresh conversation if it retains a previous forced prompt.

T3's current prompt hook returns a full system prompt. When that hook runs first,
it freezes Pi's stock prompt and this provider correctly respects the resulting
`forceSystemPrompt`. Loading this provider first lets it choose its prompt before
T3 appends its instructions. A T3-side fix is to add those instructions through
`event.systemPromptOptions.sections` instead of returning a full `systemPrompt`.

Both approaches passed live Haiku, Sonnet and Opus 5.5 tests on 2026-10-15.
See the [investigation](../../docs/claude-subscription-t3-400.md) for the evidence,
policy-source discrepancy and limits of this workaround.

Pi prices each turn at the API's list prices from its own Claude catalog, as
it does for other subscription providers, so the footer shows what the same
tokens would cost on the API. That is not what your subscription is charged. A
model newer than Pi's catalog has no known price and counts as `$0`.

## Requirements

- Pi 1.3.0 or newer, Node.js 22+.
- A Claude subscription.

## Install

The [root package](../../README.md#install-from-github) loads this package first.
Install the root package or this package by itself. From a local checkout:

```sh
npm ci --ignore-scripts
pi install "$PWD"
```

Use `pi install "$PWD/packages/claude-subscription"` for this package alone. Or
try it without changing settings:

```sh
pi -e ./packages/claude-subscription/extensions/claude-subscription/index.ts \
  --model claude-subscription/claude-sonnet-5-5
```

The Agent SDK ships the Claude Code binary for your platform (about 250 MB
installed). It is run as published.

## Sign in

If Claude Code is already signed in on this machine, there is nothing to do:
the provider appears in `/model` as soon as it sees that login.

Otherwise run `/login` in Pi, choose **Sign in with an API key** (Pi has no
other place for a login it does not hold) and then
**Claude subscription (Agent SDK)**:

- **Sign in with Claude Code** runs Claude Code's own browser sign-in. The
  credential stays with Claude Code; Pi stores nothing.
- **Paste a long-lived token**, for a machine without a browser, takes the
  token `claude setup-token` prints. Pi stores it in `auth.json`, as it stores
  other providers' keys, and passes it to Claude Code as
  `CLAUDE_CODE_OAUTH_TOKEN`.

`claude auth login` in a terminal does the same as the first route.

## Use

Pick a model with `/model` (provider `claude-subscription`) or
`--model claude-subscription/<id>`. Thinking levels map to Claude's effort
levels the way Pi's own Anthropic adapter maps them.

The extension adds nothing to Pi's footer. `/claude-subscription` shows the
account, every limit Claude Code reports with its reset time and whether it is
reached, extra-usage and fast-mode state, and an estimate of what this Pi
process has used at API list prices.

The model list starts as Pi's own Claude catalog. Once a day, when network
access is allowed, the provider asks Claude Code which models the account
offers and narrows the list to those. Context windows and output limits are
Claude Code's own, which can be smaller than the API's: on a Max plan today
Opus 4.6 and Sonnet 4.6 have 200k through Claude Code, not 1M.

## Settings

Optional, in `claude-subscription.json` in Pi's agent directory
(`~/.pi/agent`). All of it is off or at its default without the file.

| Setting | Default | What it does |
|---|---|---|
| `resume` | `false` | Claude Code keeps each conversation on disk, so a restarted Pi continues it with the model's real history and prompt cache. See below. |
| `webTools` | `false` | Adds `claude_web_search` and `claude_web_fetch`, run by Claude Code on the plan. |
| `claudeCode` | `false` | Adds `claude_code`, which hands a task to Claude Code with its own tools. |

The last two are not part of the provider and are meant to stay off: Pi's own
tools and extensions are how Pi gains capabilities. They exist for the case
where something only Claude Code can do is wanted, each runs its own
short-lived Claude Code process, and neither is on any path a model request
takes.

### Keeping sessions across restarts

With `resume` off, a Pi process that continues an earlier conversation
(`pi -c`, `--resume`) starts a new Claude Code process and shows it the earlier
turns as a text record. With it on, Claude Code writes the conversation to its
own `~/.claude/projects/` directory as it goes, and the new process resumes
that: same history, thinking included, and the prompt cache if it is still
warm. Those files hold the prompt, tool definitions and your account email, are
readable only by you, and are removed by Claude Code after 30 days. A small
record of what each kept session holds is filed under
`~/.pi/agent/claude-subscription/sessions/`.

A kept session is used only when it holds exactly the start of the transcript
Pi sends, with the same prompt, tools and working directory, and Claude Code's
copy ends where the record says. Anything else falls back to the text record.

## Compared with the `anthropic` provider

| | `anthropic` with an API key | This provider |
|---|---|---|
| System prompt | Pi's default | This package's short preamble in place of Pi's first paragraph and its pointer to Pi's docs; the rest of Pi's prompt is the same. Claude Code adds one line ("You are a Claude agent, built on Anthropic's Claude Agent SDK.") and `<system-reminder>` blocks with the working directory, platform, model, date and account email. |
| Tool names | `read` | The model is shown `mcp__pi__read`. Pi's screen, transcript and sessions say `read`, and the model is told to call tools by Pi's names when it talks to you. |
| Cost in the footer | Dollars | The same API list prices, without a `(sub)` marker: Pi shows that only for its own OAuth subscription sign-in. |
| Context window, output limit | The API's | Claude Code's, which may be smaller. |
| After a restart | The transcript, replayed exactly | A text record of it, or the kept session with `resume` on. |
| After compaction, a branch, an edited message, or a turn answered by another provider | The transcript, replayed exactly | A new Claude Code process given a text record of the earlier turns, without their thinking. |
| Switching model, thinking level or active tools mid-conversation | Seamless | Seamless: applied to the running process. Turning thinking off or on, or changing a thinking budget on the 4.5 models, starts a new process. |
| An answer you interrupt | Forgotten by the model | Still in the model's context, as in Claude Code. |
| `maxTokens`, temperature, cache retention, request headers | Honoured | Not available; Claude Code sets them. |
| `after_provider_response` and header events | Fire | Do not fire: there is no HTTP response to show. `before_provider_request` sees the turn input and may replace it; `provider_stream_event` sees every SDK message. |
| Prompt-cache warming | Available | Not used; the Claude Code process is kept instead. |
| A failed request | Retried in place | Retried by Pi with a new process and a text record. |
| A call to a tool that does not exist | Shown, and answered by Pi with an error | Answered by Claude Code itself; the turn carries on and Pi shows nothing. |

## How it works

Each Pi conversation gets one Claude Code process, started through the SDK's
streaming `query()` and kept alive between Pi's requests.

- **Prompt and tools.** The system prompt Pi built replaces Claude Code's.
  Built-in Claude Code tools, user and project settings, hooks, memory and MCP
  servers are all off. Pi's tools are presented through an in-process MCP
  server with Pi's exact schemas.
- **Tool calls.** When the model calls a tool, the provider ends Pi's request
  with `toolUse` and holds the call open. Pi runs the tool, with its own
  permission gates, and its result is handed to the waiting call. The turn then
  continues on the same native history and prompt cache.
- **Continuity.** The provider records which transcript entries the process
  has seen. A request whose transcript extends that record continues the
  process, after bringing it to the request's model, effort and tool set.
  Anything else starts a new process.
- **Steering and aborts.** Input that arrives with tool results is folded into
  the running turn. Aborting interrupts the turn and keeps the process.
- **Lifetime.** Processes close on Pi's session shutdown, after 30 idle minutes
  (five for requests without tools, such as summaries), or when more than four
  conversations are open. One that is waiting on a tool Pi is running is left
  alone however long the tool takes.

### Environment

The Claude Code process inherits Pi's environment, plus what Pi resolved for
the provider, without `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL` and the `CLAUDE_CODE_USE_*` cloud switches, so it uses the
Claude account rather than per-token API routing. Variables that describe
another Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and the
like) are removed too, so Pi can be started from inside Claude Code. If Claude
Code still reports a login that is not a subscription, the request fails with
an explanation instead of running.

### Subagents

A child Pi process needs this extension loaded to use these models. With the
`subagents` package of this collection, name it under `providerExtensions` for
`claude-subscription` in the subagent policy. A child started with its own
`--system-prompt` keeps that prompt, as described under billing above.

## Terms

Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
covers which credentials may be used where. This package is for your own use
with your own account. It runs the unmodified Claude Code binary and completes
sign-in only through Claude Code. Do not use it to offer Claude access to other
people.

## Development

```sh
npm run check
npm test
npm run test:live
```

`npm test` scripts the Agent SDK's `query()` and calls tools through the real
in-process MCP server. It needs no login and makes no network requests.

`npm run test:live` drives the real `pi` binary against your Claude plan: about
twenty short Haiku requests in half a minute. It skips itself when `pi` is not
installed or Claude Code is not signed in. See `test/live/README.md`.
