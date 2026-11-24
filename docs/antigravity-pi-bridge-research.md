# Bridging Google Antigravity into Pi — research, 2026-11-24

## Question

Can Pi reach the models behind a Google Antigravity account the way T3 Code
does, while feeling like a Pi provider in the way
[`claude-subscription`](../packages/claude-subscription/README.md) does for
Claude?

## Short answer

Probably yes, as a provider package that runs Google's unmodified `agy acp`
server and presents Pi's tools to it over MCP. Three things stand between that
and a build:

1. **Terms.** Google's terms call third-party access a breach. `agy acp` is the
   documented surface for other clients, but a Pi provider uses it differently
   from an editor. This is the owner's call, not a technical one.
2. **Two undocumented controls.** Removing Antigravity's built-in tools and
   replacing its system prompt both rest on keys Google does not document.
3. **Nothing here was run.** `agy` is not installed on this machine and
   Antigravity is disabled in the local T3 Code. Every behavioural claim below
   comes from source or documentation, not from a live session.

A short live probe (listed under [What to measure first](#what-to-measure-first))
settles item 2 and decides whether the build is worth starting.

## How T3 Code bridges Antigravity

Read from the T3 Code checkout at `~/Code/_ref/t3code`, commit
[`222288b0`](https://github.com/pingdotgg/t3code/tree/222288b00f9ed392e1e7352ad929c9ae9ac10cef).
Paths below are relative to that repository.

T3 is an ACP client of Google's own agent. It does not call Google's model
endpoints for conversation turns.

| Pattern | What T3 does | Source |
|---|---|---|
| Transport | Spawns `agy acp --gemini-dir <profile> --app-data-dir antigravity-acp` and speaks ACP (JSON-RPC over stdio). Releases before 1.5.0 were a separate harness binary. | `apps/server/src/provider/antigravityAuthSupport.ts` (`buildAntigravityAcpSpawnInput`) |
| Profile isolation | One private `GEMINI_HOME` per provider instance, so accounts never share credentials, hooks or MCP config. User skill folders are symlinked back from the real `~/.gemini`. | same file (`prepareAntigravityProfile`, `linkAntigravityUserSkills`) |
| Environment | Starts from the parent environment with every ambient Google credential variable removed (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, …), then sets `GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE=1` and a per-process temp directory. | same file (`removedEnvironmentKeys`, `antigravityEnvironment`) |
| Sign-in | The agent owns OAuth: token exchange and storage stay in the native process. T3 sets `BROWSER` to a helper that prints the authorization URL instead of opening a browser, validates that URL, and shows it. From a remote device the user pastes the `127.0.0.1` return URL back and T3 relays it to the agent's loopback listener. | same file (`parseAntigravityAuthorizationUrl`, `makeAntigravityStderrHandler`); `apps/server/src/provider/AntigravityAuth.ts`; `docs/user/providers-antigravity.md` |
| Auth methods | `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`; "sign-in required" is ACP error `-32000`. | `packages/effect-acp/test/fixtures/antigravity-initialize.json`; `antigravityAuthSupport.ts` |
| Install | Downloads the CLI from Google's release manifest, checks a SHA-512, keeps immutable versioned releases behind an atomic pointer, and leases a version to each running process. A binary path or `agy` on `PATH` overrides it. | `apps/server/src/provider/antigravityCliRelease.ts`, `AntigravityInstallation.ts` |
| Models and thinking | The model list and thinking levels come from the session's ACP config options, per account. Thinking levels are reported only for the selected model, so T3 selects each model in turn to read them. | `apps/server/src/provider/Drivers/AntigravityDriver.ts` (`publishCatalog`); `apps/server/src/provider/acp/AntigravityAcpSupport.ts` |
| Session extensions | `session/new` carries `_meta.antigravity`, with `disabledTools: [...]` and `systemPrompt: { append }`. T3 uses the first to switch off one tool (`run_workflow`) and the second to add a short instruction. | `AntigravityAcpSupport.ts` (`antigravitySessionMeta`) |
| Client capabilities | Advertises no terminal and no file writes, because advertising writes replaces the agent's diff edits with whole-file writes. | `AntigravityAcpSupport.ts` (`makeAntigravityAcpRuntime`) |
| T3's own tools | Passed as an HTTP MCP server in `session/new`. | `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts` (`mcpOverHttp`) |
| Usage per turn | The prompt response carries Gemini `usageMetadata`; input excludes cached tokens and output excludes thinking tokens. | `AntigravityAdapterV2.ts` (`geminiPromptUsage`); `packages/provider-acp/src/server/adapter.ts` |
| Plan limits | Reads the refresh token from the profile's `acp_token.json` and calls `cloudcode-pa.googleapis.com` itself, with an Antigravity user agent. | `apps/server/src/provider/antigravityUsageLimits.ts` |
| Health checks | Never spawn the agent to check status; a launch is expensive. | `AntigravityDriver.ts` (`probe`) |

What T3 does **not** do is the part that matters most here. In T3, Antigravity
stays a whole agent: it keeps its own system prompt, its own file, shell and
subagent tools, and its own conversation store. T3 renders that agent's work and
answers its permission prompts. T3's documentation lists the consequences: no
conversation rewind, no edit-and-resubmit, no manual compaction
(`docs/user/providers-antigravity.md`).

So T3 supplies the transport, sign-in, isolation and install patterns. It does
not supply the Pi-idiomatic half.

## What `claude-subscription` does that makes it Pi-idiomatic

From [its README](../packages/claude-subscription/README.md) and
[`tools.ts`](../packages/claude-subscription/extensions/claude-subscription/src/tools.ts):

1. It registers a Pi provider; models appear in `/model`.
2. Pi's system prompt replaces the vendor's.
3. The vendor's built-in tools, settings, hooks, memory and MCP servers are off.
4. Pi's tools are offered through an MCP server with Pi's schemas. A tool call
   ends Pi's request with `toolUse` and is held open until Pi returns the result.
5. One vendor process per conversation, continued while Pi's transcript extends
   what the process has seen; otherwise a new process and a text record.
6. The vendor owns the credential. Pi stores at most a pasted token.

## How each of those maps onto Antigravity

| Need | Antigravity mechanism | Standing |
|---|---|---|
| Provider, models, thinking levels | ACP `model` and thinking-level config options | Documented ([ACP guide][acp-ide]) and used by T3 |
| Streaming text and thinking, images, cancel, steering | ACP session updates; prompts sent mid-turn steer it | Documented ([ACP guide][acp-ide]) |
| Pi's tools over MCP | `mcpServers` in `session/new`; the agent advertises HTTP and SSE MCP | [ACP spec][acp-spec]; T3's initialize fixture |
| Holding a tool call open | MCP tool calls time out after 180 s by default. `timeoutSeconds` in an `mcp_config.json` entry changes it, and a negative value removes it. | Documented ([MCP][mcp]). Whether a server passed through ACP `session/new` can carry that setting is **unknown**. |
| Built-in tools off | A custom agent file with `tools: [...]`, chosen with `agy acp --agent <name>`; or `_meta.antigravity.disabledTools` on the session | `tools` and `--agent` are documented ([custom subagents][subagents], [ACP guide][acp-ide]), but the documented default for `tools` is also `[]`, so an empty list may mean "all". `disabledTools` is undocumented; T3 uses it for one tool. |
| Pi's system prompt | The Markdown body of a custom agent file "defines the subagent's system prompt"; or `_meta.antigravity.systemPrompt.append` | The body is documented ([custom subagents][subagents]); whether the harness still wraps it in its own instructions is **unknown**. `append` is undocumented and only appends. |
| Credential stays with the vendor | `agy acp` reuses the CLI's cached sign-in; `agy acp --login` signs in by pasted code and works over SSH | Documented ([ACP guide][acp-ide]) |
| Usage and cost | Per-turn token counts as above. Plan limits have no documented API. | T3 source |
| Seeding a session with Pi's transcript | None. ACP offers new, load and resume of the agent's own sessions only. | [ACP spec][acp-spec] |

The last row means the same fallback `claude-subscription` uses: after a
restart, a branch, compaction or a turn answered by another provider, start a
new session and hand it a text record of the earlier turns.

### Prior art in the Pi package gallery

Two MIT-licensed community packages already do this. Both were read from their
npm tarballs, not run.

- [`pi-antigravity-acp-provider`](https://www.npmjs.com/package/pi-antigravity-acp-provider)
  0.1.22 downloads and verifies its own ACP runtime, signs in through Pi's
  `/login`, and routes Pi tools through a loopback MCP bridge. It leaves
  Antigravity's own tools on and defaults to auto-approving them.
- [`pi-antigravity-bridge`](https://www.npmjs.com/package/pi-antigravity-bridge)
  0.1.15 needs an installed `agy` and has a `pi-tools` mode that is the shape
  wanted here. It writes a custom agent with `tools: []`,
  `disabledTools`, `excludeDefaultComponents: true`,
  `inheritCustomizations: false` and `inheritMcp: false`, and leaves the
  official system prompt in place.

The second package's changelog is the best available evidence of what goes wrong
in practice. These are its author's reports, **not verified here**:

- `tools: []` alone left `list_resources`, `read_resource` and `manage_task`
  active; they had to be named in `disabledTools`.
- The 180 s MCP limit is treated as hard; the package detaches a slow call at
  165 s and delivers its result with the next prompt.
- A single prompt is capped at about 64k of input, which breaks a long text
  record unless it is sent in pieces.
- MCP tool results carrying media over about 10 KB did not reach the model.
- A turn stops after a fixed number of tool steps and has to be continued.

The second package published 17 releases in its first three days (npm registry,
2026-11-21 to 11-23), so its behaviour is still settling.

## Terms and account risk

Google's [Antigravity terms][terms] say: "Using third party software, tools, or
services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a
breach of this Agreement. Such actions may be grounds for suspension or
termination of your Antigravity and/or Gemini CLI accounts."

Against that, Google's [ACP guide][acp-ide] says "Any ACP client can launch
Antigravity CLI" and documents `agy acp` for exactly that.

Reading the two together, with the caveat that this is not legal advice:

- Running the unmodified `agy`, letting it hold the credential, and speaking the
  documented protocol is the sanctioned route. That matches what
  `claude-subscription` does with Claude Code.
- Reading the stored token to call Google's endpoints directly is what the
  terms' own example describes. T3 does this for plan limits. The current Pi
  source (`~/Code/_ref/pi`, commit `e03dca7`) has no Antigravity provider.
  Search-result snippets say Pi once had one of this kind and removed it after
  account suspensions; I did not verify that beyond the snippets.
- A provider that strips Antigravity's tools and prompt uses the agent as a
  model endpoint, not as an agent hosted in an editor. Nothing in the documents
  read here says whether Google treats that differently.
- The ACP guide says third-party models are offered only to named editors. T3
  identified itself as `zed` to older runtimes to get them
  (`antigravityClientInfo`), and its comment says 1.5.1 lifted the restriction;
  the guide still states it. Do not copy the name substitution.

## Recommendation

Build it as a new package beside `claude-subscription`, but only after the probe
below, and only if the owner accepts the terms risk.

Take from T3:

- spawn `agy acp` with a private profile directory and a scrubbed environment;
- let the agent own sign-in, suppress its browser launch, relay the return URL;
- prefer an installed `agy`, with a verified managed download as a later step;
- advertise no client filesystem or terminal capability;
- read models and thinking levels from the session;
- never start the agent for a status check.

Take from `claude-subscription`:

- the provider shape, session reuse rule, text-record fallback and idle limits;
- the held-open MCP tool bridge, served over loopback HTTP with a per-session
  bearer token since there is no in-process transport;
- a status command instead of footer additions.

Leave out:

- direct calls to `cloudcode-pa` with the stored token;
- any client-name substitution;
- copying or editing the agent's conversation database.

Expect these differences from `claude-subscription` to remain, and document
them as that package's README does:

- the system prompt may be Antigravity's plus Pi's, not Pi's alone;
- long-running Pi tools need a workaround unless the timeout can be lifted;
- plan limits may not be reportable at all;
- no reuse of a kept session after a restart until `session/resume` is proven
  to match Pi's transcript exactly.

Adopting `pi-antigravity-bridge` instead is the cheaper alternative. It already
has the wanted mode, but it is 15k lines, three days old, and takes approaches
this repository would not, such as forking the agent's database.

## What to measure first

One afternoon with an installed, signed-in `agy` and a throwaway profile:

1. Does a custom agent with `tools: []` leave any built-in tool callable? Does
   adding `disabledTools` remove the rest?
2. With a custom agent body, what system prompt does the model actually receive?
   Ask it to describe its instructions and tools, then compare token counts with
   and without the body.
3. Does an MCP server passed in `session/new` honour a timeout setting? If not,
   does a server declared in the private profile's `mcp_config.json` with
   `timeoutSeconds: -1` hold a call for ten minutes?
4. Does the MCP call carry anything that ties it to the ACP `tool_call` update,
   and how do parallel calls arrive?
5. Does `agy acp` need `--process-per-session` for an HTTP MCP server, as the
   guide says? T3 does not pass it.
6. Which models does a client named for Pi receive on the current release?
7. What are the real limits on prompt size, tool-result size and steps per turn?
8. What does a cold start cost in time and disk?

Answers 1 to 3 decide whether the result can be called Pi-idiomatic. If built-in
tools cannot be fully removed, the package would run two tool sets side by side,
and that is not worth shipping.

## Sources

Primary:

- T3 Code source, commit `222288b0`, files named in the tables above.
- Google Antigravity docs, fetched 2026-11-24: [ACP for other editors][acp-ide],
  [CLI ACP page](https://antigravity.google/docs/cli/acp/), [MCP][mcp],
  [custom subagents][subagents],
  [CLI reference](https://antigravity.google/docs/cli/reference),
  [plans](https://antigravity.google/docs/plans),
  [SDK overview](https://antigravity.google/docs/sdk/overview).
- [Antigravity terms of service][terms], fetched 2026-11-24.
- [ACP session setup specification][acp-spec].
- This repository's `claude-subscription` package.

Secondary, used only where marked:

- npm tarballs of the two community packages.
- Search-result snippets on account suspensions.

The Antigravity Python SDK was considered and set aside: its documented
credentials are a Gemini API key or Google Cloud, which Pi's own `google`
provider already covers, and it offers no subscription sign-in.

[acp-ide]: https://antigravity.google/docs/ide/extensions/acp/
[mcp]: https://antigravity.google/docs/mcp/
[subagents]: https://antigravity.google/docs/subagents/
[terms]: https://antigravity.google/terms
[acp-spec]: https://agentclientprotocol.com/protocol/session-setup.md
