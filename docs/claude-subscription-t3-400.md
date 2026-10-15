# Claude subscription HTTP 400 in T3 Code — 2026-10-15

The observed failure is a prompt-composition interaction in T3's Pi integration.
The same installed provider and login succeed in standalone Pi. Loading the
subscription extension before T3's extension also succeeds, with T3's complete
tool catalog and orchestration instructions present.

## Reproduction and cause

Environment: Pi 1.2.0, Claude Code 2.1.296, Agent SDK 0.3.296, Node 26.9.0,
T3 Code 0.0.46-nightly.20261014.3105, existing Claude subscription login.
Pi ran from the repository root.

The user's failed T3 sessions returned:

```text
API Error: 400 Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.
```

T3 loads its generated `~/.t3/caches/pi-t3-mcp-extension.ts` as an explicit
extension before Pi discovers the installed subscription package. Its
`before_agent_start` handler returns:

```ts
return { systemPrompt: event.systemPrompt + "\n\n" + ORCHESTRATION_INSTRUCTIONS };
```

Pi treats that return as `systemPromptOptions.forceSystemPrompt`. Consequently,
`useOwnSystemPrompt` leaves it alone, as it must for a deliberately forced prompt.
The provider receives Pi's stock prompt plus T3's instructions instead of its own
prompt plus T3's instructions. This exact composition reproduced the HTTP 400.

The evidence establishes a request-content-dependent server rejection. It does
not establish Anthropic's internal classifier rules or prove that its deployment
is lagging behind policy. Supplying only Pi's stock opening paragraph explicitly
also succeeded, so the opening sentence alone is not a sufficient trigger.

## Verified workaround

Prepend the subscription extension to T3's Pi provider launch arguments:

```text
--extension /absolute/path/to/pi-packages/packages/claude-subscription/extensions/claude-subscription/index.ts
```

Keep existing arguments after it. T3 adds its own extension later, so the provider
chooses its prompt first and T3 appends its unchanged guidance afterwards. Pi
deduplicates the identical extension path also found through the installed package.
The existing `pi-claude-subscription/0.1.0` client identity is unchanged.

The workstation's `providerInstances.pi.config.launchArgs` in
`~/.t3/userdata/settings.json` was updated this way, preserving its self-reload
argument. The previous file is saved alongside it as
`settings.json.before-claude-subscription-order-20261015`. Existing Pi processes
retain their old extension order: restart the affected provider session before
retrying. If T3 has cached the old settings, re-save the launch arguments in its
provider settings or restart T3. Use a fresh conversation if an old forced prompt
persists in the conversation. No running user session was killed.

This workaround was validated by launching real Pi with those arguments and the
actual T3 extension. It was not validated by sending another turn to the user's
existing failed T3 conversation.

## T3-side fix

Replace the full-prompt return with a structured section:

```ts
pi.on("before_agent_start", (event, ctx) => {
  reconcileDiscovery(ctx);
  event.systemPromptOptions.sections.t3_orchestration = ORCHESTRATION_INSTRUCTIONS;
});
```

This preserves the entire orchestration text and lets Pi and other extensions
compose the prompt regardless of load order. A copied full T3 extension with this
one-line change passed the same live tests. The installed generated cache was not
edited: T3 can regenerate it. The durable upstream fix belongs in the generator.
The subscription provider should continue respecting explicitly forced prompts.

## Live evidence

Tests ran in live tmux sessions `cs-haiku`, `cs-sonnet`, `cs-opus`, and
`cs-diagnostics`. Each model was addressed by its exact `claude-*-5-5` ID.
All three models produced the following results:

- Standalone Pi, both isolated and normal project settings: plain prompt passed.
- Interactive Pi in tmux: Pi's `read` tool read `package.json` and the final answer
  correctly reported `pi-packages-repo`, version `0.0.0`.
- Original complete T3 extension loaded first: HTTP 400 before any tool call.
- Complete T3 extension with the structured-section fix: successful Pi `read`
  call and final answer, with `--thinking high`.
- Original complete T3 extension with the subscription extension loaded first:
  successful Pi `read` call and final answer, with `--thinking high`.

The complete-extension tests used the live T3 tool catalog. The prompts restricted
execution to Pi's read tool; no T3 task or conversation was launched. Tokens were
passed through the child environment without being written to test artifacts.
Local logs and probe scripts are in `/tmp/cs-investigation-20261015` and are not
committed. Success was determined from assistant `stopReason`, tool results and
answer text: Pi's JSON print process exited zero even for provider errors.

The deterministic prompt regression covers the failing composition, both working
orders for the section fix, and preservation of project context. The existing live
suite now accepts `CS_LIVE_MODEL` and checks API list-price estimates rather than
its obsolete zero-cost expectation. A successful request or Pi's estimated cost
does not independently establish the account's final billing treatment.

Final validation: `./scripts/check.sh` passed. The full live suite passed **10/10
checks on each of Haiku, Sonnet and Opus 5.5**, with no skipped or cancelled tests
(30 checks total). This includes tool execution, follow-up turns, abort recovery,
saved-session continuation, high thinking and plan-limit events. The full suite
uses isolated Pi configuration; the complete T3 integration was exercised in the
separate before/after tests above.

## Published guidance

Read on 2026-10-15:

- [Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  has an October 7 update saying SDK, headless Claude Code and third-party apps
  can still use subscription limits, alongside new Max/Team API credits.
- [Claude account login](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account),
  marked updated that day, prefers API authentication for third-party tools and
  reserves discretion to charge their use to usage credits. It also prohibits
  misrepresentation of client identity.
- [Monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)
  distinguishes Console API credits from Claude extra usage: the former do not
  cover the latter. API-key SDK calls use Console credits; subscription-authenticated
  SDK calls are described as drawing from plan limits.

These pages do not give a consistent guarantee that every third-party request
will draw from plan limits. The tested workaround fixes prompt composition; it
cannot guarantee future server classification. If Anthropic continues rejecting
a request, its documented alternative is Pi's `anthropic` provider with a Console
API key (including claimed monthly API credits where eligible), or extra usage
as directed by the error. Neither billing route was enabled during this work.
