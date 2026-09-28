#!/usr/bin/env bash
# Manual, offline TUI QA. No personal MCP config, auth, built-in tools, or paid model calls.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-mcp-demo-XXXXXX")"
trap 'rm -rf -- "$DEMO_DIR"' EXIT
export PI_CODING_AGENT_DIR="$DEMO_DIR" PI_TELEMETRY=0 PI_OFFLINE=1
export MCP_DEMO_ROOT="$ROOT"
node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  import { join } from "node:path";
  const dir = process.env.PI_CODING_AGENT_DIR;
  writeFileSync(join(dir, "mode"), "fast");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ quietStartup: true }));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ servers: { demo: {
    transport: "stdio", protocol: "2025-11-25", command: process.execPath,
    args: [join(process.env.MCP_DEMO_ROOT, "packages/mcp-client/test/fixtures/tui-server.mjs"), join(dir, "mode")],
    elicitation: true, timeout: 60000,
  } } }));
'
printf 'Offline fixture state: %s (removed on exit)\n' "$DEMO_DIR"
printf 'Type slow, form, or fail. Commands: /mcp status, /mcp refresh, /mcp prompt, /mcp subscribe.\n'
cd "$ROOT"
pi --offline --no-session --no-approve --no-extensions --no-skills \
  --no-prompt-templates --no-context-files --no-builtin-tools \
  -e "$ROOT/packages/mcp-client/index.ts" \
  -e "$ROOT/packages/mcp-client/test/fixtures/tui-provider.mjs" \
  --provider mcp-ui-fixture --model offline --thinking off "$@"
