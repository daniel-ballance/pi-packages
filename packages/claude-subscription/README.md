# claude-subscription

A Pi provider that reaches Claude models through the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and the
Claude account Claude Code is signed in to. Pi stays the harness: its tools,
sessions and compaction are unchanged. Claude Code is only the transport, and
its login is the only credential. While a model from this provider is selected,
Pi's default system prompt is replaced with a short prompt of this package's own.

## Read this first: how Anthropic bills it

Anthropic's [support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
says Agent SDK, `claude -p` and third-party app usage draw from subscription
limits. In practice the outcome depends on what the request contains.

Checked on 2026-10-13 with a Max plan and Agent SDK 0.3.296:

| Request sent through this provider | Anthropic's response |
|---|---|
| Plain Agent SDK use: a neutral system prompt and custom tools | Accepted, counted against plan limits |
| Pi's stock system prompt | `400 Third-party apps now draw from your extra usage, not your plan limits.` |

So with Pi's default prompt, Anthropic treats the traffic as a third-party app
and bills it to **extra usage**, not plan limits. If extra usage is off for the
account, a request that still carries that prompt is rejected with that message,
which Pi shows as is.

This package does not send that default. On `before_agent_start`, when the
selected model belongs to this provider and you have not set your own prompt, it
sets Pi's `customPrompt` to its own short text. That is the same option
`SYSTEM.md` and `--system-prompt` fill, so a prompt from either of those is sent
as you wrote it. Project context, skills, an appended prompt, and the working
directory are still added. A prompt you supply that is Pi's default text can
still draw the rejection above. A one-line Haiku request with this package's
prompt, from an empty directory, was accepted and did not return that error.

Costs appear as `$0` in Pi because nothing is billed per token to Pi. That is
not a claim about what your Anthropic account is charged.

## Requirements

- Pi 0.99.2 or newer, Node.js 22+.
- Claude Code signed in with a Claude account: `claude auth login`. If
  `CLAUDE_CODE_OAUTH_TOKEN` is set instead, the provider treats Claude Code as
  signed in and passes the variable through; that path has not been exercised.

Sign-in happens only in Claude Code. This package has no `/login` flow, never
reads or stores the credential, and the provider appears in `/model` only once
Claude Code has a login.

## Install

This package is **not part of the root collection manifest**. Load it on its own.
From a local checkout:

```sh
npm ci --ignore-scripts
pi install "$PWD/packages/claude-subscription"
```

Or try it without changing settings:

```sh
pi -e ./packages/claude-subscription/extensions/claude-subscription/index.ts \
  --model claude-subscription/claude-sonnet-5-5
```

The Agent SDK ships the Claude Code binary for your platform (about 250 MB
installed). It is run as published.

## Use

Pick a model with `/model` (provider `claude-subscription`) or
`--model claude-subscription/<id>`. Thinking levels map to Claude's effort
levels. `/claude-subscription` shows the signed-in account, its plan and the
latest plan-limit notice. The footer shows a limit only when it is close or
reached.

The model list starts as Pi's own Claude catalog. Once a day, when network
access is allowed, the provider asks Claude Code which models the account
offers and narrows the list to those. A model newer than the installed Pi gets
its context window from Claude Code.

## How it works

Each Pi conversation gets one Claude Code process, started through the SDK's
streaming `query()` and kept alive between Pi's requests.

- **Prompt and tools.** The system prompt is this package's short prompt, or
  one you set yourself, and it replaces Claude Code's. Built-in
  Claude Code tools, user and project settings, hooks, memory files and MCP
  servers are all off. Pi's tools are presented through an in-process MCP
  server, so the model sees them as `mcp__pi__<name>` with Pi's exact schemas.
- **Tool calls.** When the model calls a tool, the provider ends Pi's request
  with `toolUse` and holds the call open. Pi runs the tool, with its own
  permission gates, and its result is handed to the waiting call. The turn then
  continues on the same native history and prompt cache.
- **Continuity.** The provider records which transcript entries the process
  has seen. A request whose transcript extends that record continues the
  process. Anything else (compaction, a branch, an edited history, a different
  model, prompt or tool set, a restart) starts a new process seeded with the
  earlier turns as a tagged text record.
- **Steering and aborts.** Input that arrives with tool results is folded into
  the running turn. Aborting interrupts the turn and keeps the process.
- **Lifetime.** Processes close on Pi's session shutdown, after 30 idle minutes
  (one minute for tool-less requests such as summaries), or when more than four
  are open.

### What Claude Code adds

The request is Pi's, with two additions from the Agent SDK: the system prompt
is prefixed with "You are a Claude agent, built on Anthropic's Claude Agent
SDK.", and the first user message carries short `<system-reminder>` blocks
(working directory, platform, model, date, account email).

### Environment

The Claude Code process inherits Pi's environment without `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the `CLAUDE_CODE_USE_*` cloud
switches, so it uses the Claude account rather than per-token API routing. If
Claude Code still reports a login that is not a subscription, the request fails
with an explanation instead of running. `CLAUDE_AGENT_SDK_CLIENT_APP` identifies
the caller to Anthropic as `pi-claude-subscription/<version>`.

## Limits

- A seeded process sees earlier turns as text, without their thinking blocks.
- Any failed request discards its process, so the retry is seeded.
- `maxTokens` is not forwarded; Claude Code sets the output limit per model.
- `onResponse` is not called: the SDK exposes no HTTP response. `onPayload`
  receives the turn input and may replace its `input`; `onProviderStreamEvent`
  receives every SDK message.
- Tool names are sent as `mcp__pi__<name>`, so very long Pi tool names can
  exceed the API's 64-character limit.
- Claude Code's own compaction is off; Pi compacts.

## Terms

Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
covers which credentials may be used where. This package is for your own use
with your own account. It runs the unmodified Claude Code binary, completes
sign-in only through Claude Code, and does not collect, store or relay
credentials. Do not use it to offer Claude access to other people.

## Development

```sh
npm run check
npm test
```

Tests script the Agent SDK's `query()` and call tools through the real
in-process MCP server. They need no login and make no network requests.
