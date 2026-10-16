#!/usr/bin/env bash
set -euo pipefail

# Canonical repository gate; it is also exposed as the root `npm run check` script.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/package-manager.sh"

# Keep the root gate reproducible and independent of a caller's Pi session or
# an optional installed Pi executable. Package tests use their local fixtures
# and the Pi runtime installed in their own package node_modules.
export CI=1
export PI_OFFLINE=1
export PI_TELEMETRY=0
export PI_SKIP_VERSION_CHECK=1
unset PEER_TEST_EXECUTABLE PEER_TEST_CLI
unset PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR PI_PACKAGE_DIR
unset PI_SUBAGENT PI_SUBAGENT_ALLOWED_TOOLS PI_SUBAGENT_PEER_FD PI_SUBAGENT_POLICY
unset T3_MCP_URL T3_MCP_BEARER_TOKEN T3_PI_RUNTIME_MODE T3_PI_MCP_EXTENSION_PATH
# Git hooks export repository variables such as GIT_DIR. Left set, every git
# command in a check (submodule pins, git apply) would act on this repository
# instead of the directory it names.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)

printf '%s\n' '== repository configuration =='
node scripts/check-json.mjs

printf '\n%s\n' '== shared modules =='
node scripts/sync-shared.mjs --check
node --test shared/*.test.ts scripts/*.test.mjs

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

# Packages lint their skills with this repository tool, so test it first.
printf '\n%s\n' '== lint-skill: test =='
"$PACKAGE_MANAGER" --prefix scripts/lint-skill run test

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
  "$PACKAGE_MANAGER" --prefix "$package_dir" run check
  printf '\n== %s: test ==\n' "$package_name"
  "$PACKAGE_MANAGER" --prefix "$package_dir" run test
  if [[ "$package_name" == "mcp-client" ]]; then
    printf '\n== %s: format:check ==\n' "$package_name"
    "$PACKAGE_MANAGER" --prefix "$package_dir" run format:check
  fi
done

printf '\n%s\n' 'Root check passed.'
