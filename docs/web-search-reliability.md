# web-search reliability: investigation and recommendation

Status: proposal, awaiting the owner's decision. No code has changed.
Date: 2026-11-08. Branch: `research/web-search-reliability`.

## Summary

- **Root cause.** DuckDuckGo's no-JavaScript endpoints (`html.duckduckgo.com/html/`, `lite.duckduckgo.com/lite/`) run a bot blocker keyed on the **client IP address**. Once it trips, every request from that IP gets HTTP 202 and an image CAPTCHA page (`anomaly.js?…&cc=botnet`), whichever endpoint, query, or pacing is used. The query shape (`site:`) and our honest User-Agent are not the trigger on their own: both succeeded on a fresh attempt. Volume from the IP is. Today the fourth of four requests spaced 60 s apart was challenged. The package cannot fix this by changing headers without impersonating a browser, which this document rejects.
- **What makes it worse today.** The tool keeps no memory of a block, so every agent, subagent, and Pi process on the machine keeps sending requests into it. The DuckDuckGo-side window may be sliding, so requests during a block can extend it, as hot testing suggested. Repeated queries are not cached.
- **Recommendation.** Keep DuckDuckGo as the keyless default, but make it polite and honest: a **cooldown shared across processes** that sends no request while it lasts and reports its end time, plus **minimum spacing** and a **search-result cache**. Add a keyless **`web_fetch`** tool (URL → readable text with an outline, section extraction, and size bounds). For docs lookups this matters more than search, since the agent usually knows or can guess the official URL. Then add **optional keyed providers** behind the same `web_search` tool (Brave Search API first, self-hosted SearXNG second). They are configured in the user's agent directory, with keys read from environment variables only.
- **Sequence.** Five small PRs (see [PR plan](#pr-plan)). After the first two, the host map can drop its "never retry" workaround in favor of the tool's own `[cooldown]` report. After the third, the curl-and-grep step becomes `web_fetch`.

## 1. Current package

`packages/web-search` registers one tool, `web_search` (`extensions/web-search/src/index.ts`). The provider (`src/duckduckgo.ts`):

- sends `GET https://html.duckduckgo.com/html/?q=<query>` with `Accept: text/html` and `User-Agent: pi-web-search/0.1.0`, `redirect: 'error'`, a 20 s timeout and a 2 MiB body cap;
- treats HTTP 202/403/429, or challenge markup (`#challenge-form`, `.anomaly-modal__modal`, `form[action*="anomaly.js"]`), as `[blocked]`;
- parses `.result` rows with Cheerio, decodes `uddg` redirect links, skips ads and duplicates, and caps titles and snippets;
- keeps no state: no cooldown, no pacing, no cache, and no fallback. The README states that there are no retries.

Tests (`test/search.test.ts`) are offline, use an injected `fetch`, and cover parsing, blocking, limits, timeouts and cancellation. Accepted queries can be up to 1000 characters, but DuckDuckGo rejects queries of 500 characters or more, according to SearXNG's engine notes (below).

Error reporting is already honest: a block is a failed tool call, not an empty result. What is missing is any memory of the block.

## 2. Reproduction (2026-11-08, one residential IP)

Method: `/tmp` probe script using Node's global `fetch` (undici), as the package does. One request per run, the package's own headers unless noted, and each response body saved. Sparse on purpose. A full burst test was not repeated, because the IP blocked before reaching that stage.

| UTC time | Request | Result |
|---|---|---|
| ~15:21 | 2 × `curl` to `duckduckgo.com/?q=…` (accidental: a wrong URL for the terms page redirected into a search) | 202 |
| 15:24:41 | html, GET, `typescript satisfies operator` | 200, 10 results |
| 15:25:42 | html, GET, `site:typescriptlang.org satisfies operator` | 200, 10 results |
| 15:26:43 | html, **POST** form, same `site:` query | 200, 10 results |
| 15:27:43 | **lite**, GET, same `site:` query | **202**, CAPTCHA page, `anomaly.js?sv=lite&cc=botnet` |
| 15:29:36 | html, GET, new `site:nodejs.org …` query | **202**, CAPTCHA, `sv=html&cc=botnet` |
| 15:33:51 | html, GET (recovery probe, +4 min) | 202 |
| ~15:36 | 1 × `curl` to `duckduckgo.com/api` (accidental: it now redirects into a search for "api") | 202 |
| 15:39:51 | html, GET (+10 min) | 202 |
| 15:47:51 | html, GET (+18 min) | 202 |
| 15:59:52 | html, GET (+30 min) | 202; probing stopped here so as not to extend the block |

The CAPTCHA page reads: "Unfortunately, bots use DuckDuckGo too. Please complete the following challenge to confirm this search was made by a human. Select all squares containing a duck". The same IP had also been blocked earlier the same day during hot testing, so its standing was probably already low. The sample is small and confounded. Read it as consistent evidence, not a measured threshold.

### Findings

1. **The block is per IP and covers both no-JS endpoints.** After the lite request was challenged, a fresh html query was challenged too. DuckDuckGo has no client session (no cookies beyond region settings), so nothing in our request can identify a "good" client. SearXNG's maintained DuckDuckGo engine documents the same thing: "In DDG's bot blocker, the IP will be blocked (DDG does not have a client session!)" ([searx/engines/duckduckgo.py](https://github.com/searxng/searxng/blob/master/searx/engines/duckduckgo.py), read 2026-11-08).
2. **`site:` and the `pi-web-search/0.1.0` User-Agent are not sufficient triggers.** The first `site:` requests with that exact User-Agent returned full results, over both GET and POST.
3. **Volume from the IP is the trigger, and the threshold is low and variable.** Today three no-JS requests in 2 minutes succeeded and the fourth was challenged, after 2 main-site requests, on an IP already flagged earlier. Hot testing tripped it with about 3 quick queries. Pacing at 20 s or 60 s does not keep a client under the threshold.
4. **The block outlasts the burst, and probing it may extend it.** SearXNG's notes say that blocking was historically "a 'sliding window' (unblock after about 1 hour without requests from this IP)" and changed in Q3/Q4 2025. SearXNG suspends its DuckDuckGo engine for 3600 s after a CAPTCHA by default (`suspended_times.SearxEngineCaptcha` in [searx/settings.yml](https://github.com/searxng/searxng/blob/master/searx/settings.yml)). Hot testing saw a 4+ minute block while probing every 20 s. Today the block still held **30 minutes** after the first challenge, with only 4 probes 4–12 minutes apart. Whether those probes extended it is unknown. Recovery beyond 30 minutes was not measured.
5. **Header changes that might help are impersonation.** SearXNG sends a browser User-Agent, `Sec-Fetch-*` headers and a `Referer` to look like a browser form submission. The `ddgs` Python library goes further and impersonates browser TLS fingerprints (from prior knowledge of its `primp` dependency, not re-read today). Both work by hiding that the client is automated.

### Terms

DuckDuckGo's [Terms of Service](https://duckduckgo.com/terms) (last updated 2025-01-07) say "We expect you to use our Services as authorized, or we may otherwise suspend access" and incorporate the [Acceptable Use Policy](https://duckduckgo.com/acceptable-use). The policy forbids attempts to "access … the services … without authorization", conduct that is "deceptive", and anything that "interfere[s] with or disrupt[s] the integrity or performance of the services". Neither document mentions automated queries explicitly. `html.` and `lite.duckduckgo.com/robots.txt` allow all paths. `duckduckgo.com/robots.txt` disallows `/html` and `/lite`, but that file covers only the main host.

Reading: a low-volume client that identifies itself honestly and stops when challenged is defensible. Spoofing a browser, rotating IPs, or solving or bypassing the CAPTCHA would get around a control DuckDuckGo applied on purpose, so this package should not do any of them. DuckDuckGo's official Instant Answer API (`api.duckduckgo.com`) is keyless and sanctioned, but it returns zero-click answers, not web results, so it cannot replace the scraper. This is from prior knowledge: its documentation page was not re-read today, because its old URL now redirects into a search.

## 3. Options

### 3.1 Cooldown, pacing and honest reporting (keyless, recommended)

- **Shared cooldown.** On `[blocked]`, record `blockedUntil` in a state file under Pi's agent directory (`<agentDir>/web-search/state.json`, written atomically via rename; a corrupt or missing file means no state). Every Pi process, subagent and T3 child on the machine reads it, so they share it the way they share the IP. While it lasts, `web_search` sends **no request** and fails at once:
  `[cooldown] DuckDuckGo blocked this machine's IP at 15:29 UTC. No request sent. Searches resume after 16:29 UTC (in 52 min). Use context7 or web_fetch on a known URL meanwhile.`
  Proposed default: 60 minutes, doubling for each consecutive block up to 4 hours, and reset by a successful search. That follows today's block lasting over 30 minutes and SearXNG's 3600 s CAPTCHA suspension. The first search after expiry is the only probe.
- **Minimum spacing.** At most one DuckDuckGo request every 10 s across processes, recorded in the same state file as `lastRequestAt`. When the next slot is ≤ 15 s away, wait for it (abortable, shown as a partial update: "Waiting 8 s to pace DuckDuckGo"). Otherwise fail with `[paced]` and the time of the next slot. Spacing alone does not prevent blocks (finding 3). It limits fan-out from parallel subagents, which is the likeliest way to send a burst.
- **No automatic retries**, now as before. The cooldown makes "do not retry" something the tool enforces, not advice to the agent.
- **Small request fixes.** Cap queries at 499 characters (DuckDuckGo rejects longer ones). Add the repository URL to the User-Agent (`pi-web-search/<version> (+https://github.com/…)`) so the client stays identifiable. Keep GET: POST worked no better.

Trade-offs: no cost, no keys, no privacy change. It does not raise how often searches succeed; it stops making things worse and tells the agent the truth. One assumption: per-machine state stands in for per-IP state. A VPN switch while a cooldown is active gives a false cooldown, which expires on its own.

### 3.2 Request changes

| Change | Within terms? | Evidence it helps | Verdict |
|---|---|---|---|
| POST form instead of GET | Yes: what the html page's own form does | None; GET and POST both succeeded and both are blocked once the IP is | Not worth changing |
| lite instead of html | Yes | None; blocked together | No |
| Browser User-Agent, `Sec-Fetch-*`, `Referer` | No: impersonation | Anecdotal (SearXNG) | Reject |
| TLS fingerprint impersonation (`ddgs`/`primp` style) | No | Reported | Reject |
| CAPTCHA solving, proxy/IP rotation | No | n/a | Reject |
| Query ≤ 499 characters, User-Agent with contact URL | Yes | Correctness and courtesy | Do it (3.1) |

### 3.3 Additional providers behind one tool

`web_search` keeps its arguments (`query`, `limit`) and result shape (`title`, `url`, `snippet`). Its details and text add the provider that answered and the providers it skipped, with the reason for each. Providers are tried in a configured order. A provider in cooldown, missing its key, blocked, timing out, out of quota (402/429), or failing with a 5xx is skipped or abandoned in favor of the next. No provider is retried within one call. Each provider gets its own cooldown. With no configuration, the only provider is DuckDuckGo, so the package keeps working without a key.

| Provider | Key | Cost (vendor page, read 2026-11-08) | Docs-lookup quality | Privacy and terms | Notes |
|---|---|---|---|---|---|
| DuckDuckGo html (current) | none | free | good; `site:` works | unofficial endpoint; IP blocks | default |
| **Brave Search API** | yes | [$5 per 1,000 requests, $5 free credit monthly](https://brave.com/search/api/) (about 1,000 free searches) | own independent index; `site:` inside `q` is [documented](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started) | sanctioned API; the query goes to Brave | `GET api.search.brave.com/res/v1/web/search`, header `X-Subscription-Token`, `web.results[].{title,url,description}`; simplest mapping |
| **SearXNG (self-hosted)** | none (owner runs it) | free | depends on the engines enabled | queries stay on the owner's instance until it fans them out to engines; the terms question moves to that instance | [JSON output](https://docs.searxng.org/dev/search_api.html) must be enabled in `settings.yml` (`format=json`, otherwise 403); "many public instances have these formats disabled", so do not default to public instances. If its DuckDuckGo engine shares our IP, it shares the block |
| Tavily | yes | [1,000 credits/month free, no card](https://www.tavily.com/pricing); then $0.008/credit | AI-oriented; can return page extracts | sanctioned | `site:` maps to `include_domains` |
| Exa | yes | [$10 credit monthly free](https://exa.ai/pricing); search from $4 per 1,000 | strong on technical docs (vendor claim) | sanctioned | neural search; `site:` maps to `includeDomains` |
| Kagi Search API | yes | paid, Kagi account ([docs](https://help.kagi.com/kagi/api/search.html)) | high | sanctioned; inherits account settings | cost and account requirements make it a poor default |
| Marginalia | shared `public` key | free, non-commercial | poor for framework docs (small-web index) | the `public` key "often hits a rate limit" ([API docs](https://about.marginalia-search.com/article/api/)) | not recommended |
| `claude_web_search` (claude-subscription, `webTools: true`) | Claude plan | plan usage | good | Anthropic | already exists as a separate tool. Keep it separate and mention it in the host map; do not wrap it |

Recommended: implement the provider seam with DuckDuckGo, **Brave** (cheapest sanctioned key with an independent index and `site:` support) and **SearXNG** (keyless for owners who self-host). Tavily and Exa fit the same seam later if wanted.

**Configuration.** `<agentDir>/web-search.json`, read only from the user's agent directory, as `claude-subscription.json` is. A project file could otherwise send queries to an attacker's SearXNG.

```json
{
  "providers": ["brave", "duckduckgo"],
  "brave": { "apiKeyEnv": "BRAVE_SEARCH_API_KEY" },
  "searxng": { "url": "http://127.0.0.1:8888" },
  "cooldownMinutes": 60,
  "cacheHours": 24
}
```

Keys come only from the environment variable named in the file. The parser rejects any key-shaped field (`apiKey`, `token`) with a clear problem message. This matters here because the owner's `~/.pi/agent/*.json` files are symlinks into this repository's `global/` directory, so a key written into a config file could be committed. A provider listed without its variable set is skipped with the reason shown. Keyed providers are never enabled just because a variable exists: spending credits needs an explicit `providers` entry.

### 3.4 `web_fetch` (keyless, recommended)

Hot testing showed `curl -sL` fetching 6 of 6 official doc pages, at 59 KB to 1.1 MB each, which the agent then had to grep. Docs lookups rarely need search when the official URL is known or guessable. A fetch tool turns that into one bounded, readable step:

```
web_fetch({ url, section?, outline?, offset?, maxChars? })
```

- **outline: true** returns the title, final URL, content type, size, and the heading tree (level, text, `#id`, characters per section), so the agent can choose a section without reading the page.
- **section** (heading text, case-insensitive substring) or a URL `#fragment` returns that heading up to the next heading of the same or higher level. When no heading matches, `[section_not_found]` lists the nearest headings.
- **Default** returns the main content (`main`, `article`, `[role=main]`, else `body` without `nav`, `header`, `footer`, `aside`, `script` and `style`) as Markdown-like text: headings, lists, code blocks kept verbatim, and links as `text (url)`. Long output stops at `maxChars` (default 20,000; maximum 40,000, under Pi's 50 KiB tool limit) and gives the `offset` that continues it.
- **Bounds and safety.** http(s) only. At most 5 redirects, each checked again. A 5 MiB download cap and a 20 s timeout, with cancellation. text/html, text/plain, text/markdown and JSON are accepted; anything else (PDF, binaries) gives `[unsupported_type]`. Credentials in URLs are rejected. Output starts with "untrusted web content". Loopback, link-local and private addresses are refused by default (a prompt-injected page could otherwise make the agent probe the LAN), with a config switch to allow them.
- **Cache.** In-process LRU (about 20 pages, 10 minutes), so an outline and then a section costs one download.
- **Dependencies.** Cheerio, which the package already ships. No headless browser: JavaScript-only docs sites are out of scope, and the tool says so when a page has almost no text.
- **Host parity.** T3 offers no fetch primitive, so `web_fetch` duplicates nothing and is registered `direct` on both hosts (`duplicatesT3: false` if it goes through `registerHostAware`). Its result is complete as plain text and it calls no `ctx.ui`, so ADR 0001 is satisfied without T3-specific behavior. `claude_web_fetch` stays a separate opt-in in claude-subscription.

Trade-offs: keyless, no third party between agent and site (unlike reader services such as `r.jina.ai`, which would see every URL), deterministic, and fast. Extraction quality is heuristic. Reader-mode libraries (`@mozilla/readability` with a DOM) do better on article pages but add dependencies, and docs pages have clean `main` and heading markup anyway.

### 3.5 Result caching

Cache search results on disk under `<agentDir>/web-search/cache/`, keyed by provider and normalized query (trimmed, whitespace collapsed). Store all parsed results and slice to `limit` when reading, with a TTL of 24 h (configurable, 0 disables). Hits are labelled in the output and details (`cached 14:02 UTC`). Only successes are cached, never errors. Parallel subagents in a fan-out often run the same "site:… <concept>" query, so the cache cuts both load and block risk at no cost. Privacy: queries are stored locally in plain text, as Pi's session files already store them. The README will say so, and `cacheHours: 0` disables the cache.

## 4. Constraints checked

- **No key by default.** Default configuration: DuckDuckGo plus `web_fetch`, both keyless.
- **No secrets in the repo.** Keys only through environment variables. Config fields shaped like keys are rejected. Tests use fake values.
- **Offline tests.** Every provider and `web_fetch` takes an injected `fetch`. The clock and the state directory are injected too (a temporary directory per test). Live checks stay manual, like today's TUI fixture `live` prompt.
- **`./scripts/check.sh` green.** Each PR keeps `npm run check` and `npm test` passing in `packages/web-search`. The root `pi` block is unchanged (same extension entry point), so `node scripts/root-package.mjs` is needed only if the manifest changes.
- **Host parity** ([GLOSSARY](../GLOSSARY.md) "Host parity", [ADR 0001](adr/0001-host-parity.md)). Neither tool duplicates a T3 primitive, results are plain text, and no `ctx.ui` calls are added. If a later change uses `shared/host.ts`, the tests run twice, as the ADR requires.
- **Generated skills.** The host map's generated copy is regenerated from `packages/p3stack/extra/…`, and `source-grounding` changes go through `rules/` or overlays, per `packages/p3stack/AGENTS.md`. Neither is hand-edited.

## PR plan

Each PR touches `packages/web-search` (plus docs where stated) and keeps `./scripts/check.sh` green.

### PR 1: shared cooldown and pacing for DuckDuckGo

Scope: a state module (`src/state.ts`: atomic JSON read/write, injected clock and directory), the cooldown and spacing described in 3.1, the 499-character query cap, the User-Agent with the repository URL, new error categories `[cooldown]` and `[paced]` with the TUI rendering them, and README updates.
Acceptance tests (offline):
- After a 202 response, a second search within the cooldown makes **zero** `fetch` calls and throws `[cooldown]` with the resume time.
- Two provider instances sharing one state directory honor each other's cooldown, standing in for two processes.
- The cooldown doubles on consecutive blocks, caps at 4 h, and resets after a success.
- When the spacing wait is ≤ 15 s, the search waits and can be cancelled during the wait. A longer wait gives `[paced]` with no `fetch`.
- A corrupt state file is ignored and rewritten. A state directory that cannot be written still allows searching, and the cooldown then lasts only for the process (reported).
- A 500-character query is rejected before any network access.

### PR 2: search result cache

Scope: the disk cache from 3.5, the `cacheHours` setting (environment or default until PR 4 adds the config file), and the "cached" label in output and TUI.
Acceptance tests: a repeat query makes zero `fetch` calls and is labelled cached. Different `limit` values are served from one entry. An expired entry fetches again. Errors are not cached. `cacheHours: 0` disables the cache. A query is not served from the cache of a different provider.

### PR 3: `web_fetch`

Scope: a new tool in the same package (`src/fetch.ts`, `src/extract.ts`), registered beside `web_search`, with README, a TUI renderer, and a fixture in `test/fixtures/tui-demo.mjs`.
Acceptance tests (synthetic HTML fixtures, not copies of real docs):
- Main-content extraction drops nav, footer and script, and keeps headings, lists and code blocks verbatim.
- The outline lists headings with ids and sizes. `section` by text and by `#fragment` returns exactly that section. A missing section lists the nearest headings.
- `maxChars` truncation reports the continuing `offset`, and the next call resumes there.
- The download cap cancels the stream. The timeout and cancellation behave as in `web_search`. Redirects are capped and checked again (a redirect to `file:` or to a private address is refused).
- Unsupported content types and credentialed URLs are rejected. Private, loopback and link-local hosts are refused unless allowed.
- An outline followed by a section within the cache window makes one `fetch` call.
- Tool registration: present on both hosts, `direct` exposure.

### PR 4: provider seam, configuration, Brave and SearXNG

Scope: a `SearchProvider` interface (`search(query, limit, signal, deps)`), DuckDuckGo moved behind it, `brave.ts` and `searxng.ts`, config loading from `<agentDir>/web-search.json` (pattern of `claude-subscription/src/config.ts`: per-key validation, problems reported, never thrown), the ordered chain with skipped-provider reasons, and per-provider cooldowns.
Acceptance tests:
- With no config file, DuckDuckGo is the only provider and current behavior is unchanged (the existing suite passes untouched).
- The Brave request has the correct URL, `count`, and `X-Subscription-Token` taken from the named environment variable. Its JSON maps to `{title,url,snippet}`. A 401 is reported as a key problem, and 402/429 as quota or rate limits leading to a provider cooldown.
- SearXNG requests `format=json` from the configured URL. A 403 is reported as "JSON format disabled on this instance".
- Chain: with Brave quota exhausted, the call falls over to DuckDuckGo in one call, and the result names both and the reason. A provider in cooldown is skipped with no `fetch`. A listed provider whose environment variable is unset is skipped with that reason.
- A config containing `apiKey` or `token` values is rejected with a problem message. A project-level file is not read.

### PR 5: guidance updates (p3stack)

Scope: the host map source (`packages/p3stack/extra/skills/poteto-mode/references/host-capabilities.md`) and its regenerated copy, a `source-grounding` overlay or rule that names the "Fetch official docs" capability, and the behavior-eval case `source-grounding` accepting `^web_fetch$` as fetched docs.
Acceptance: `./scripts/check.sh` passes (generator, lint-skill, pin checks), and the behavior eval passes with and without p3stack-mode.

## Guidance after the change

**Host map, "Fetch official docs"** (proposed text, applied in PR 5):

1. **context7** when configured: unchanged.
2. **`web_fetch <url>`** for a known official page. Call it with `outline: true` first on a large page, then with `section`. Fall back to `curl -sL` and `grep` only when `web_fetch` is not available.
3. **`web_search`** with a `site:` filter to find the page URL, then step 2. The tool paces itself and remembers blocks for the whole machine. On `[cooldown]` or `[paced]` it has sent nothing: do not retry before the time it reports; use steps 1 and 2 meanwhile. When the owner has configured other providers, the tool falls over to them by itself and says which one answered.
4. Where claude-subscription's `webTools` is enabled, `claude_web_search` and `claude_web_fetch` are a further fallback that uses the Claude plan.

**`source-grounding`**: Step 2 should say that fetching follows the host map's "Fetch official docs" capability and keep the rest of its source hierarchy. It should name no tool inline, per the GLOSSARY "Contract" rule.

## Decisions for the owner

1. **Cooldown length.** The proposal is 60 minutes, doubling to a 4-hour cap (SearXNG uses 60 minutes; today's block lasted over 30). A shorter first cooldown (for example 30 minutes) gives more availability, but each early probe risks extending the block.
2. **Keyed provider activation.** The proposal requires an explicit `providers` list. The alternative is to activate automatically when `BRAVE_SEARCH_API_KEY` is set: more convenient, but it spends credits silently.
3. **Which keyed provider to build first.** Brave is proposed. Tavily or Exa if result extracts matter more than an independent index.
4. **`web_fetch` and private networks.** The proposal refuses them by default. Allow them by default if the owner fetches local docs servers often.
5. **PR order.** PRs 1–3 are keyless and independent of each other's code beyond the state module. PR 3 alone gives most of the docs-lookup benefit, so it could land first.
