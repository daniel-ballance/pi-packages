# Changelog

## Unreleased

- Add `--disable-native-subagents` for launch-scoped opt-out of all native management, workflow and notification startup. Unflagged TUI/RPC launches and unrelated extensions are unchanged.
- Stay inactive in Pi sessions launched by T3 Code with its MCP bridge (`T3_MCP_URL` set), as if `--disable-native-subagents` were passed. T3's delegated tasks are the subagent system there; direct Pi launches are unchanged.
- Add `alwaysExtensions`/`alwaysTools` policy fields: allowlisted entries every child receives without parent selection. An unavailable always-on entry disables spawning instead of being skipped. Existing policies are unchanged.

## 0.3.0 — 2026-10-01

- Require Pi 0.99.2; update development dependencies and npm/pnpm locks.
- Add opt-in managed native codemode, tool-search and MCP extensions. Reject unknown built-ins and llama.cpp; no implicit grants in existing version-1 policies.
- Enforce selected tool sources inside children, including nested calls. Filter discovery and authorize MCP tools by original names, including sanitized-name collisions.
- Add provider-extension linkage, MCP project/credential consent, codemode settings and optional cache-warming suppression. Disable codemode classifiers and reject virtual models.
- Preserve RPC input dispositions across child/peer/workflow reporting; consumed inputs do not leave phantom running work or count as completed workflow tasks.
- Refresh authoritative cumulative cost on standalone usage entries, including idle cache warming; avoid nested-call double counting.
- Add offline native-runtime fixtures and regression tests. Legacy MCP package and personal policies are unchanged.
