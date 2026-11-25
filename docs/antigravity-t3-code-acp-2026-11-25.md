# How T3 Code drives Antigravity, compared with `antigravity-provider`

Researched 2026-11-25. Sources:

- T3 Code source at `pingdotgg/t3code` `7d8c03fd999467843c70178fe655e05eeab2aeb5` (origin/main that day). Paths below are relative to that repository.
- Google's ACP guide, <https://antigravity.google/docs/ide/extensions/acp> and <https://antigravity.google/docs/cli/acp>, fetched that day.
- Google's terms, <https://antigravity.google/terms>, fetched that day.

No Antigravity model request was made for this note.

## What T3 Code sends to `agy`

| Aspect | T3 Code | Source |
| --- | --- | --- |
| Launch | `agy acp --gemini-dir <T3 profile> --app-data-dir antigravity-acp`. No `--agent`, no `--add-dir`, no custom agent file. | `apps/server/src/provider/antigravityAuthSupport.ts` `buildAntigravityAcpSpawnInput` |
| Agent | `agy`'s default agent, with its own system prompt and its own built-in tools (`run_command`, `edit_file`, `read_file`, subagents and the rest). `agy` executes them; T3 renders the tool calls and answers permission requests. | Same file; `apps/server/src/provider/acp/AntigravityAcpSupport.ts` `antigravityPermissionDisposition` |
| System prompt | Appends one short block through `_meta.antigravity.systemPrompt.append`: `PULL_REQUEST_LINKING_INSTRUCTIONS` (1,253 characters about linking and watching PRs). Only for conversational sessions; text generation and probes leave the prompt untouched. | `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts` line 165; `packages/provider-core/src/server/runtimeInstructions.ts` line 13; `AntigravityAcpSupport.ts` `antigravitySessionMeta` |
| Identity | Says openly who it is. It appends to the user prompt `<runtime_info>In case you're asked: you are running in T3 Code through the Antigravity harness, as <model>…</runtime_info>`. | `runtimeInstructions.ts` line 38; `packages/provider-acp/src/server/adapter.ts` lines 9373 to 9406 |
| `clientInfo` | `{ name: "t3-code", title: "T3 Code" }` on `agy` 1.5.1 or later. Before 1.5.1 it sent `{ name: "zed", version: "0.0.0" }`, because older runtimes offered non-Gemini models only to allowlisted editors. | `AntigravityAcpSupport.ts` `antigravityClientInfo` |
| Extra tools | T3's own MCP server (`t3-code`: delegation, PR, thread tools) is added to the session alongside `agy`'s tools, over HTTP MCP where offered. The model reaches it natively (`mcp_t3-code_<tool>`) or through `call_mcp_tool`. | `AntigravityAdapterV2.ts` `mcpOverHttp: true`; `AntigravityAcpSupport.ts` lines 189 to 208 |
| Client capabilities | `fs.readTextFile` true (T3 serves reads), `writeTextFile` false, `terminal` false. | `AntigravityAcpSupport.ts` `makeAntigravityAcpRuntime` |
| Sign-in | `agy`'s own flow (`agy acp --login`, code pasted from `antigravity.google/oauth-callback`). T3 never handles a Google token itself. | `antigravityAuthSupport.ts`; `docs/user/providers-antigravity.md` |

## What Google says

- The ACP guide invites any client: "Any ACP client can launch Antigravity CLI." It also says what the client gets: "The agent, its tools, your sign-in, and your settings come from Antigravity CLI, so the agent behaves the same in the editor as it does in the terminal."
- It documents `--agent` and `--add-dir` as ordinary `agy acp` flags. Custom agents are a documented feature (<https://antigravity.google/docs/subagents>). `excludeDefaultComponents` appears in the `agy` changelog. The `systemPrompt.append` capability is advertised in `initialize` but not described in the guide.
- It names clients: Zed, JetBrains IDEs, Android Studio, Xcode, and a community VS Code extension. It does not name T3 Code. It says third-party models are offered only to the named editors. On `agy` 1.5.17 a client named `probe` was offered Claude and GPT models in an ACP model-catalog probe that sent no prompt, and T3's code comment dates that opening to 1.5.1. The guide looks out of date on this point (inferred).
- The terms: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement."

## Evidence of Google's approval of T3 Code

The only statement found is T3's own FAQ (`docs/user/faq.md` line 56): "We work with all of the labs and T3 Code is within the TOS of Claude Code, Codex, and Google Antigravity. … Everything else uses official ACP bindings." It names a direct collaboration only with SpaceXAI. No Google page found names T3 Code or describes an agreement with it.

## How `antigravity-provider` differs

| Aspect | T3 Code | First design (`c7f78c6`, replaced) |
| --- | --- | --- |
| Whose agent runs | `agy`'s | Pi's. A hidden custom agent with `excludeDefaultComponents: true` removes `agy`'s prompt and built-in tools. |
| System prompt | `agy`'s, plus 1,253 characters | Pi's whole prompt (about 23,000 characters) replacing `agy`'s |
| Tools | `agy`'s, executed by `agy`; T3's MCP tools added | Every Pi tool, executed by Pi, reached only through `call_mcp_tool` |
| What `agy` is | The coding agent | A transport to the model |
| Identity text | "running in T3 Code through the Antigravity harness" (user message) | "You are running inside pi, a coding agent harness." (system prompt) |
| Observed backend response | Not tested here | HTTP 429 `RESOURCE_EXHAUSTED`, deterministic on that one sentence; close rewordings pass |

The terms' example is software that uses Antigravity's login to drive the model with another harness. The first design had that shape: `agy` keeps the login and Pi replaces the agent. T3 has the shape Google's ACP guide describes: a client shows `agy`'s agent. Rewording Pi's identity sentence would change what the backend's check sees, not which of the two shapes the provider has.

## A design in T3's shape for Pi

1. Launch `agy acp` with no custom agent, so `agy`'s prompt and tools stay.
2. Send `clientInfo` naming Pi plainly.
3. Append a short Pi block in the spirit of T3's: Pi conventions only, not Pi's whole prompt.
4. Offer Pi-only capabilities (for example T3 or p3stack tools) as an added MCP server, as T3 does.
5. Render `agy`'s tool calls, diffs and permission requests in Pi, and answer permissions from Pi's policy.

What Pi gives up compared with the first design: Pi's own `read`, `bash` and `edit` tools, Pi's tool gates as the execution path, and Pi's transcript replay and compaction. `agy` owns those. In Pi this is closer to a delegate tool or a separate agent than to a model provider.

## Open questions

- Whether the backend check also fires on T3's runtime_info sentence, which says "harness". Not tested; testing needs an Antigravity request.
- Whether Google regards T3's appended block as acceptable. Only T3's FAQ asserts it.

**Current design:** [`antigravity-provider`](../packages/antigravity-provider/README.md) runs agy's default agent over plain ACP and identifies itself openly as Pi. It appends a runtime note and selected Pi instruction sections rather than replacing agy's system prompt. Pi renders agy's actions and routes permission decisions through its tool gates; only Pi extension tools execute in Pi via the separate MCP bridge. This design has not been tested against the live backend in this note.
