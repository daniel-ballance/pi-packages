#!/usr/bin/env bash
set -euo pipefail

# Canonical repository gate; it is also exposed as the root `npm run check` script.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Keep the root gate reproducible and independent of a caller's Pi session or
# an optional installed Pi executable. Package tests use their local fixtures
# and the Pi runtime installed in their own package node_modules.
export CI=1
export PI_OFFLINE=1
export PI_TELEMETRY=0
export PI_SKIP_VERSION_CHECK=1
unset PEER_TEST_EXECUTABLE PEER_TEST_CLI
unset PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR PI_PACKAGE_DIR
unset PI_SUBAGENT PI_SUBAGENT_ALLOWED_TOOLS PI_SUBAGENT_PEER_FD

printf '%s\n' '== repository configuration =='
node scripts/check-json.mjs

if [[ -f "$ROOT/.pi/subagents.json" ]]; then
  printf '%s\n' '== project subagent policy =='
  (
    cd "$ROOT/packages/subagents"
    POLICY_PATH="$ROOT/.pi/subagents.json" node --import tsx --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { parsePolicy } from "./extensions/subagents/src/policy.ts";
      const path = process.env.POLICY_PATH;
      parsePolicy(JSON.parse(readFileSync(path, "utf8")));
      console.log(`parsePolicy accepted ${path}`);
    '
  )
fi

shopt -s nullglob
package_jsons=(packages/*/package.json)
if ((${#package_jsons[@]} == 0)); then
  printf '%s\n' 'No packages found under packages/' >&2
  exit 1
fi

for package_json in "${package_jsons[@]}"; do
  package_dir="${package_json%/package.json}"
  package_name="$(basename "$package_dir")"
  printf '\n== %s: check ==\n' "$package_name"
  npm --prefix "$package_dir" run check
  printf '\n== %s: test ==\n' "$package_name"
  npm --prefix "$package_dir" test
  if [[ "$package_name" == "mcp-client" ]]; then
    printf '\n== %s: format:check ==\n' "$package_name"
    npm --prefix "$package_dir" run format:check
  fi
done

printf '\n%s\n' 'Root check passed.'
