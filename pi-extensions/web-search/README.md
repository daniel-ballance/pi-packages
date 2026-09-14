# web-search

Zero-configuration DuckDuckGo web search for Pi. Adds one native `web_search` tool returning titles, URLs, and snippets. No API key, MCP server, Python, or browser required.

## Install

Requires Node.js 22+; developed and tested against Pi 0.85.1.

From the repository root:

```bash
cd pi-extensions/web-search
npm ci
pi install "$PWD"
```

Then run `/reload` in Pi (or start a new Pi process). Local package installs reference this directory without copying it. To try it without changing Pi settings:

```bash
pi -e ./index.ts
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

`src/duckduckgo.ts` contains the provider and parser; `src/index.ts` contains the Pi tool registration. The only third-party runtime dependency beyond Pi's supplied packages is Cheerio for HTML parsing.
