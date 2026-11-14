# Claude Subscription stock-prompt billing recheck — 2026-11-14

## Result

The October stock-prompt rejection **did not reproduce** in this live recheck.
Through this repository's `claude-subscription` provider, both the extension's
normal prompt and the full stock Pi prompt succeeded on Claude Haiku 5.5 and
Claude Opus 5.5. Every request returned `OK`, an assistant stop reason of `stop`,
and an SDK rate-limit event with `isUsingOverage: false`.

The account was a Claude Max subscription. Extra usage was disabled before and
after every request; the usage API's `rate_limits.spend.used.amount_minor`
remained `0` USD cents. No billing setting was changed. This is direct evidence
of accepted subscription requests without extra usage, not merely inference from
successful HTTP responses or Pi's API-list-price estimates.

This finding supersedes the October result **for the account, versions and
controlled requests tested here**. It does not establish Anthropic's internal
classification rules, the date a change happened, or a guarantee for all future
requests. The initial recheck left the extension's prompt replacement unchanged;
subsequent implementation verification is recorded below.

## Environment

- Test window: 2026-11-14, 20:08:22–20:08:41 UTC.
- Repository commit: `c3b88c7`; extension version `0.1.0`.
- Pi: installed native binary, `1.5.2`.
- Claude Agent SDK: `0.3.323`; SDK-reported Claude Code `2.1.323`.
- Node: `26.13.1`.
- Auth: Claude Code reported `loggedIn: true`, `authMethod: claude.ai`,
  `subscriptionType: max`, `apiProvider: firstParty`.
- Provider/model IDs: `claude-subscription/claude-haiku-5-5` and
  `claude-subscription/claude-opus-5-5`.

## Method

Used the existing [live-test harness](../packages/claude-subscription/test/live/support.ts)
to launch real Pi processes with this checkout's extension and an isolated,
throwaway project and Pi configuration. Within each model pair the working
directory, tool selection, model, thinking level and user request were identical.
Each case used a new conversation and a new Claude Code process.

- User request: `Reply with exactly OK. Do not call any tools.`
- Pi tools attached: `read`, `bash`, `edit`, `write`; none were invoked.
- Thinking: `low`.
- No other packages, skills, context files, MCP configuration, or T3 extension.
- Automatic Pi and provider retries disabled; one provider request per case.
- Per-token API-routing environment variables removed by the existing test
  harness and provider; package client identity unchanged.
- Claude Code's usage-report API queried before and after every case through
  [`ClaudeSubscription.planUsage`](../packages/claude-subscription/extensions/claude-subscription/src/provider.ts).

The control used the extension's normal prompt selection. To test stock Pi,
a diagnostic extension loaded **before** the subscription provider returned:

```ts
pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt }));
```

That freezes Pi's complete stock prompt before the subscription provider's hook;
the provider deliberately respects forced prompts. This is the same prompt
composition mechanism documented in the [October investigation](claude-subscription-t3-400.md).
A read-only `before_provider_request` observer asserted the selected provider and
model and captured the rendered prompt. The stock cases began with:

```text
You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.
```

They contained the complete Pi documentation section, tool list and rules, not
just that opening sentence. The normal extension cases used the package's own
preamble and omitted Pi's documentation section. Stock prompts were 2,258
characters; extension prompts were 1,372 characters.

The raw SDK event observer retained only prompt metadata, rate-limit information,
model/version fields and result/usage fields. Account email, credentials and
request headers were not logged.

## Per-request evidence

- Haiku, extension prompt: `2026-11-14T20:08:24.237Z`, `OK`, `stop`.
- Haiku, stock prompt: `2026-11-14T20:08:26.177Z`, `OK`, `stop`.
- Opus, extension prompt: `2026-11-14T20:08:38.157Z`, `OK`, `stop`.
- Opus, stock prompt: `2026-11-14T20:08:40.572Z`, `OK`, `stop`.

All four SDK `rate_limit_event.rate_limit_info` values reported:

```json
{
  "status": "allowed",
  "resetsAt": 1794956400,
  "rateLimitType": "seven_day",
  "overageStatus": "rejected",
  "overageDisabledReason": "org_level_disabled",
  "isUsingOverage": false,
  "unifiedWindows": {
    "seven_day": {
      "utilization": 0.01,
      "resetsAt": 1794956400,
      "status": "allowed"
    }
  }
}
```

`overageStatus: rejected` describes unavailable extra usage, **not a rejected
model request**; request status was `allowed`. Before/after usage reports also
showed `spend.enabled: false` and `extra_usage.is_enabled: false`.

The full usage report rounded weekly utilization to 2%, while turn events
reported 0.01. No precise request-level quota decrement is inferred from those
coarse or differently refreshed values. The explicit no-overage flag and disabled
extra usage are the relevant signals. API-list-price estimates are not bills.

## Artifacts and validation

Probe scripts, filtered event logs and JSON summaries are retained locally under
`.pi/worktrees/billing-artifacts/` in the `fix/claude-subscription-native-prompt`
worktree. The runner is `probe.mts`; it uses existing `Workspace` / `runPi`
helpers. The commands below describe the pre-removal experiment at `c3b88c7`,
not the renamed provider in the resulting PR:

```sh
node --import tsx .pi/worktrees/billing-artifacts/probe.mts
BILLING_MODEL=claude-subscription/claude-opus-5-5 \
  node --import tsx .pi/worktrees/billing-artifacts/probe.mts
```

An initial attempt to select stock with `--system-prompt ""` was caught by the
rendered-prompt assertion: the CLI still selected the extension prompt. Its two
Haiku requests are excluded from the A/B findings and its artifacts carry the
`.invalid-empty-prompt-control` suffix. The corrected experiment used the
forced-prompt hook above. Six short model requests were made in total, four in
the valid comparison.

Existing prompt-composition tests also passed, **5/5**:

```sh
node --import tsx --test packages/claude-subscription/test/prompt.test.ts
```

The initial billing experiment did not run the root check or full live suite.
It did not exercise the full T3 orchestration prompt or real project context.

## Verification after removing the substitute prompt

The follow-up change removes the prompt-rewriting hook and its duplicate prompt
builder, and registers the provider as `claude` instead of `claude-subscription`.
The package, extension path, status command and client identity stay unchanged.

- Native-prompt regression tests went from **6 failures / 12 tests** on the old
  implementation to **12/12 passing**. They cover the default prompt, Pi's tool
  guidance, hidden tools, project context, skills, custom/empty/forced prompts,
  switching providers and both host-extension orders.
- Package typecheck and all **161 unit tests** passed.
- The complete Haiku live suite passed **10/10**, using `claude/claude-haiku-5-5`:
  native prompt contents, Pi tool execution, parallel calls, continued turns,
  abort recovery, saved sessions, high thinking, quota events and the catalog.
- Opus plain-answer and Pi-read-tool live checks passed **2/2** using
  `claude/claude-opus-5-5`. The unmodified native prompt is asserted in the
  plain-answer test.
- An additional Opus quota check passed and reported:

  ```json
  {"status":"allowed","rateLimitType":"seven_day","isUsingOverage":false,"overageStatus":"rejected"}
  ```

- `./scripts/check.sh` passed, including the p3stack child-policy and packaging
  checks. The final push also runs this gate through the committed pre-push hook.

The Pareto `.pi/model-selection.json` mirror was renamed in a separate worktree,
including its provider expectation and exact configuration snapshot; `make verify`
passed **319 tests** at **99.85% coverage**, with its existing uv 0.13.8 executable.
No live global configuration or billing setting was changed. The full T3
orchestration prompt and other accounts remain outside this recheck's scope.
