# web-search

Zero-configuration DuckDuckGo web search for Pi. Adds one native `web_search` tool returning titles, URLs, and snippets. No API key, MCP server, Python, or browser required.

## Install

Requires Node.js 22+; developed and tested against Pi 0.85.1.

From the repository root:

```bash
npm ci --ignore-scripts
cd packages/web-search
pi install "$PWD"
```

Then run `/reload` in Pi (or start a new Pi process). Local package installs reference this directory without copying it. To try it without changing Pi settings:

```bash
pi -e ./extensions/web-search/index.ts
```

## Usage

Ask the agent to search the web, for example:

> Search the web for TypeScript's documentation on satisfies and cite the sources.

Tool arguments:

```json
{ "query": "site:typescriptlang.org satisfies operator", "limit": 5 }
```

- `query`: nonblank string, at most 1000 characters. Search operators such as `site:` are passed through to DuckDuckGo.
- `limit`: integer from 1 to 10, default 5. Searches only the first results page; fewer results may be returned.
- Results include `title`, `url`, and `snippet`. Duplicate URLs and recognized ads are skipped; DuckDuckGo redirect links are decoded. No result pages are fetched.

## Tool display

While a request is running, the tool shows “Searching DuckDuckGo” and its 20-second timeout. Completed searches show the result count and up to three titles/domains, explicitly labelled **snippets only; pages not opened**. Expand the tool to see the complete query, all returned URLs and snippets. Expansion cannot recover text clipped by the provider's output limits.

Confirmed empty results suggest broadening the query. Provider failures remain failed tool calls, with categories such as `[blocked]`, `[timeout]`, `[network_error]` and `[unexpected_page]`; they are not displayed as empty results. Cancellation retains Pi's native handling. There are no extra notifications or automatic retries.

The model still receives bounded JSON results, independently of the compact TUI display. Search only discovers sources: use a separate page-reading tool to verify source contents before treating snippets as evidence. There are no freshness or regional controls.

## Limitations and safety

This uses DuckDuckGo's **unofficial HTML search interface**, not its Instant Answer API. There is no supported API contract, guaranteed quota, or availability guarantee. CAPTCHAs, rate limits, and HTML changes can break searches. A live check during development encountered both a CAPTCHA and successful results.

Blocking responses (HTTP 202/403/429 or recognized challenge HTML) and unrecognized pages throw tool errors rather than returning misleading empty results. Recognized no-results markup returns an empty result list. There are no automatic retries, CAPTCHA bypasses, or fallback providers; wait before trying again if blocked.

Requests time out after 20 seconds and support Pi cancellation, including during response streaming. HTML responses are limited to 2 MiB. HTTP redirects are rejected. Titles and snippets are capped at 200 and 500 characters respectively, with an ellipsis when shortened. URLs longer than 2048 characters are omitted rather than truncated. These limits keep tool text under 50 KiB and 2000 lines; discarded content is not saved.

Search terms are sent to DuckDuckGo, which also sees the request's IP address. Do not search for secrets or private source code. Results are untrusted web content, not instructions; snippets are not a substitute for reading a source page. The tool only returns HTTP(S) links and never visits them.

## Development

```bash
npm ci
npm run check
npm test
```

Tests use representative HTML and mocked fetch responses, with no network requests. They cover parsing, URL decoding, ads/duplicates, output limits, blocking, empty results, unexpected HTML, validation, HTTP errors, response-size limits, timeouts, cancellation, and tool registration/execution.

### Interactive display fixture

From the repository root, after installing this package's dependencies:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" PI_TELEMETRY=0 pi \
  --offline --no-extensions --no-skills --no-prompt-templates \
  --no-context-files --no-session --no-approve \
  -e ./packages/web-search/extensions/web-search/index.ts \
  -e ./packages/web-search/test/fixtures/tui-demo.mjs \
  --tools web_search --model search-demo/stub --tui-mode fullscreen
```

This explicitly loads only the search extension and a **test-only fake model/provider**. It does not use model credentials or make model requests. The fixture replaces fetch in this isolated process; do not load it into your normal agent session.

Enter `success`, `empty`, `blocked`, `unexpected`, or `network` to replay a response after a three-second delay. Enter `slow` to exercise the real 20-second timeout, or press Escape during it to cancel. Ctrl+O toggles result expansion (unless rebound). Resize the terminal to check wrapping. Any other prompt produces mocked successful results, making long queries easy to test.

Only the exact prompt `live` sends a real DuckDuckGo search for `site:typescriptlang.org satisfies operator`. `--offline` disables Pi startup networking, not tool requests. Do not repeat live searches if blocked.

Repeat with `--tui-mode regular` to check scrollback mode. On Pi 0.87.1, native cancellation displays “The operation was aborted” in the tool row and a separate turn-level error; the extension deliberately preserves cancellation semantics rather than disguising it as a successful result.

`extensions/web-search/src/duckduckgo.ts` contains the provider and parser; `extensions/web-search/src/index.ts` contains the Pi tool registration. The only third-party runtime dependency beyond Pi's supplied packages is Cheerio for HTML parsing.
