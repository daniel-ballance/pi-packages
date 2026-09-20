# subscription-usage

> **STATUS: scaffolded, NOT installed.**
>
> Not linked into `~/.pi/agent`, not loaded by Pi. Typechecks clean, 22/22
> unit tests pass, and the live smoke test against both upstreams succeeded
> on 2026-09-20. Nothing is polling anything right now.
>
> **To try it:** `pi install ~/Code/pi-extensions/subscription-usage`
> **To remove it:** `pi remove subscription-usage`
> **To re-verify without loading it:** `npm run smoke`

ChatGPT Pro and SuperGrok subscription usage in the Pi footer and via
`/usage`.

```
GPT 5% · SG —
```

```
Subscription usage
  GPT ChatGPT Pro: 5% weekly · resets 6d 20h
  SG  SuperGrok: — weekly · resets 6d 1h  (Usage percent not reported)
```

Reads the OAuth grants Pi already holds — no separate login, no separate
token file.

## Install

```bash
pi install ~/Code/pi-extensions/subscription-usage
```

Requires Pi signed in to both:

```
/login openai-codex     # ChatGPT Pro
/login xai              # SuperGrok — choose "Use a subscription"
```

An inference-only `XAI_API_KEY` is not enough; the weekly quota lives on the
subscription grant.

## What it does

| Surface | Behaviour |
|---|---|
| Footer | `ctx.ui.setStatus` shows `GPT n% · SG n%`, refreshed on session start and after each settled agent turn |
| `/usage` | Force-refresh and print the full per-window breakdown |
| Failure | Each provider fails independently — one dead upstream never hides the other |

A 120s TTL plus a single in-flight guard means at most one request pair per
window, no matter how many events fire.

## Endpoints

Both are **private and undocumented**. No SLA, no changelog, they can break
without notice.

| Provider | Endpoint | Auth |
|---|---|---|
| ChatGPT Pro | `GET https://chatgpt.com/backend-api/wham/usage` | `Authorization: Bearer` + `chatgpt-account-id` |
| SuperGrok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` | `Authorization: Bearer` + `x-grok-client-mode: cli` |

`/backend-api/codex/usage` returns a byte-identical payload to `wham/usage`.
A browser-ish `User-Agent` matters — OpenAI's edge 403s bare clients on the
HTML routes.

## Layout

```
index.ts              Pi wiring: footer, /usage, lifecycle
src/types.ts          ProviderUsage, UsageWindow, UsageUnavailableError
src/auth.ts           Read openai-codex + xai from ~/.pi/agent/auth.json
src/chatgpt.ts        ChatGPT Pro client + pure parser
src/supergrok.ts      SuperGrok client + pure parser
src/format.ts         Countdown, window, footer, summary formatting
scripts/smoke.ts      Live smoke test against the real upstreams
```

Parsers are pure functions over captured payloads, so the tests never touch
the network.

## Design notes

**Missing ≠ zero.** Grok speaks proto3 JSON, which omits zero-valued
fields. An absent `creditUsagePercent` is rendered as `—` with a note rather
than a fabricated `0%`. The `used`/`monthlyLimit` ratio is used as a
fallback when the percentage is absent but the counters are present.

**Nothing is invented.** No windows → "No rate-limit windows reported".
No token → "no openai-codex OAuth token (run /login openai-codex)". A
footer that says `—` is more useful than one that lies.

**Percent is 0..100 here.** Note the Omarchy collectors in
`~/Work/omarchy-customizations/agents` use a 0..1 fraction, because that is
what the panel's contract wants.

## Development

```bash
npm run check    # tsc --noEmit
npm test         # 22 unit tests, no network
npm run smoke    # live against both upstreams
```

## Companion

The same two subscriptions on the Omarchy top bar, via the `omarchy.agents`
panel's collector contract:

`~/Work/omarchy-customizations/agents/`

## Caveats

- Undocumented upstreams; expect occasional breakage. Failures surface as
  footer text, not stack traces.
- Pi owns the OAuth refresh cycle. A 401 means re-run `/login`, not
  "restart the extension".
- ChatGPT's terms restrict automated/programmatic use of Pro. This is a
  read-only poll of your own usage meter on a generous TTL; keep it that way.
