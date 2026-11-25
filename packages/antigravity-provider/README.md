# Antigravity provider for Pi

Pick an `antigravity/<model>` in Pi to use Pi's interface with Antigravity CLI's **own default agent**. Pi shows text, thinking, tool cards, diffs, questions, and a session transcript. `agy` runs the agent and owns its built-in tools, sign-in, and settings. The two communicate over [Agent Client Protocol](https://agentclientprotocol.com/protocol/overview) (ACP).

## Requirements and use

- Pi 1.6+, Node.js 22.19+, and Antigravity CLI 1.5.17 or compatible on macOS or Linux. The standalone Pi executable also needs `node` on `PATH` for the MCP shim. `PI_ANTIGRAVITY_AGY` can point to a different `agy` installation.
- Sign in with Google using `agy` or `agy acp --login`. Pi neither stores nor exchanges a Google credential. The provider does not pass `GEMINI_API_KEY` or `GOOGLE_API_KEY` to `agy`. Models are selectable when the executable is installed; `agy` checks sign-in on session creation.

This package is optional and is not loaded by the repository root package. From a checkout with dependencies installed:

```sh
pi install "$PWD/packages/antigravity-provider"
```

Select a model with `/model`, or try the extension without installing it:

```sh
pi -e ./packages/antigravity-provider/extensions/antigravity-provider/index.ts \
  --model antigravity/gemini-3.8-flash
```

## Models and thinking

Use the model family without agy's thinking suffix. When Pi permits network access, it refreshes the model catalog with an ACP handshake, without prompting the agent. Pi caches the result for up to a day or until the executable changes. The account's catalog takes precedence over the baseline:

| Pi model family | agy thinking levels |
|---|---|
| `gemini-4-neon`, `gemini-4-hydrogen` | low, medium, high, xhigh |
| `gemini-4-carbon`, `gemini-4-argon`, `gemini-3.8-flash` | low, medium, high |
| `claude-opus-5-5`, `claude-sonnet-5-5` | low, medium, high |
| `gemini-pro-orchestrator`, `gemini-pro-orchestrator-neon`, `gemini-pro-orchestrator-argon`, `gpt-oss-120b-medium` | Fixed |

| Pi setting | Target `thought_level` |
|---|---|
| off, minimal, low | low |
| medium | medium |
| high | high |
| xhigh, max | xhigh |

For adjustable models, Pi uses the nearest offered level, preferring the lower one on ties. `off` does not disable thinking in agy. Fixed models use agy's setting. Pi takes usage and the context window from ACP when reported. Cache reads are separate from input, and thought tokens are already in output. Pi shows zero cost because the provider has no per-token prices; plan limits still apply.

## How it works

- **Agent and instructions.** Pi runs plain `agy acp` in Pi's working directory and identifies itself as `pi` in `initialize.clientInfo`. `agy` loads its own rules and skills. Pi appends a short note explaining the interface and forwards its structured addendum, project context, skills, and extension sections (such as p3stack and T3). It omits Pi's agent preamble, tool catalog, rules, docs, and cwd sections, project `AGENTS.md` / `GEMINI.md` that agy already loads from this directory up to the Git root, and sections that copy Pi's agent preamble. A forced, unstructured system prompt is not forwarded. Changes to the model note or forwarded sections precede the next ACP prompt without restarting agy.
- **Tool cards and permissions.** ACP reports agy's own tool calls. Pi renders them as `antigravity` cards with title, output, and any edits reported as diffs. This stand-in is active by default but is never offered to a model. For permission requests, reaching the stand-in's execution grants **allow once**; a Pi `tool_call` hook that blocks execution causes **reject once**. Reads or actions agy executes without asking are only reported, not retroactively gated by Pi. If an allowlist omits `antigravity`, Pi shows agy's tool activity as text, denies permissions for agy's own tools, and cancels questions. Active Pi extension tools still work over MCP, even in this fallback. An empty allowlist uses this fallback too. Do not treat Pi's allowlist or tool gates as a sandbox for agy.
- **Questions.** agy's question choices appear in Pi's selector. Without an interactive UI, Pi cancels the question and records why. An answer is not a tool approval.
- **Pi extension tools.** A session-level `pi` MCP server advertises callable extension tools, not Pi's file, shell, web, search, or codemode surfaces. `agy` can call them natively or through `call_mcp_tool`. The bridge approves routing to its own MCP server; actual execution still goes through Pi's validation and `tool_call` hooks. Active tools use their own Pi cards; inactive deferred/codemode tools run through `ctx.executeTool` under an Antigravity card. The listing reflects Pi's current tools. After 150 seconds the bridge returns a still-running notice and can collect the eventual result through `await_tool_result`, without rerunning the original tool. Results larger than 8 MiB return an error.
- **Turn flow.** agy can start multiple calls before Pi renders a batch of cards. The provider keeps the ACP turn open as Pi runs those cards and returns results. If a new permission, question, or MCP call needs Pi while a card is waiting, the waiting card returns “Still running in Antigravity” so Pi can handle the new request. The earlier action can finish in agy and report its result as text. If it later asks for permission, Pi gives it a new card. Steering input received with tool results becomes a new ACP prompt after the current one ends, in the same Pi response. A background wake starts a hidden Pi turn when the matching conversation is idle on Antigravity; that turn shows the buffered updates without prompting agy. If Pi cannot wake that conversation, updates are held for its next response. A tool that outlasts the prompt can report its completion there even though its card has already returned.
- **Continuity.** Requests extending the transcript continue the same ACP session. Model and thinking changes apply in place. A branch, edit, compaction, turn with another provider, or restart can require a new ACP session; the first prompt includes a text record of the earlier turns, including short Antigravity tool-result summaries. Explicit `toolChoice: "none"` requests and Pi summary requests run in disposable sessions without MCP, deny all permissions, and cancel questions. Restoring agy's native history with `session/load` is not supported.
- **Lifetime.** Abort sends `session/cancel` and keeps the process if it settles promptly, even when Pi records aborted stand-in results before the next prompt. Pi closes sessions on shutdown, evicts idle sessions after 30 minutes or least-recently-used above four, and does not evict sessions with an open prompt or pending cards. `agy` keeps its own logs and local state.

## Compared with a native Pi provider

| | Native Pi provider | Antigravity provider |
|---|---|---|
| Agent | Pi's system prompt and tools | agy's default agent, with Pi interface context appended |
| Files, commands, web | Pi's `read`, `bash`, `edit`, and other applicable tools | agy runs its own tools. Extensions that gate `read`, `bash`, or `edit` must handle `antigravity` instead. |
| Extensions | Pi declares and executes its tools | Callable Pi extension tools are bridged over MCP and execute in Pi |
| Sign-in and usage | Provider credentials and usage in Pi | agy's sign-in and ACP usage; Google account limits still apply |
| Restart, branch, or compaction | Native transcript replay | Marked transcript record in a new ACP session |
| Provider hooks | Native payload, response and stream hooks | `onPayload` sees Pi's input and tool results; `onProviderStreamEvent` sees ACP updates; no HTTP response hooks |

## Terms

This extension runs the Antigravity CLI's own agent as described in [Google's ACP guide](https://antigravity.google/docs/cli/acp). It is not a Google product or a guarantee of account eligibility. You are responsible for your account and for complying with [Google Antigravity's terms](https://antigravity.google/terms) and your plan limits.

## Tests

From `packages/antigravity-provider`, run `npm run check` and `npm test`. The normal suite uses a fake ACP agent, real Pi sessions, and the package's real MCP socket and shim; it makes no Google requests. **Only run `npm run test:live` when authorized to make an Antigravity request.** It reads a temporary nonce through agy's `read_file` and leaves a private outgoing ACP trace at the path it prints (or a new path set in `PI_ANTIGRAVITY_TRACE`).
