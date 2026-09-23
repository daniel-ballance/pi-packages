# Pi extensions

- [subagents](subagents/README.md) — persistent RPC child agents with composable `subagents.json` allowlists, peer messaging, bounded workflows, supervision, and saved-session recovery.
- [self-reload](self-reload/README.md) — agent-requested runtime reload with automatic continuation, for rapid extension development.

- [web-search](web-search/README.md) — zero-configuration DuckDuckGo web search with titles, URLs, and snippets; no API key required.
- [subscription-usage](subscription-usage/README.md) — ChatGPT Pro and SuperGrok subscription usage in the footer and via `/usage`, read from the OAuth grants Pi already holds. **Scaffolded, not installed.**
- [mcp-client](mcp-client/README.md) — native Pi integration for legacy MCP and the 2026-07-28 protocol, including tools, resources, prompts, completions, subscriptions, and opt-in elicitation/sampling.

## Design notes

- [Failure-only MCP status](docs/mcp-status/README.md) — rationale, mockup, and visual references.
