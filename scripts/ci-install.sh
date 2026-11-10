#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# CI installs the Pi version the lockfiles select, the latest stable release at the last update.
PI_VERSION="${1:-locked}"
if [[ "$PI_VERSION" != locked ]]; then
  printf 'Unsupported Pi version: %s (CI installs only the Pi version in the lockfiles)\n' "$PI_VERSION" >&2
  exit 2
fi

source "$ROOT/scripts/package-manager.sh"

# Each manager uses its own committed root workspace lockfile.
if [[ "$PACKAGE_MANAGER" == pnpm ]]; then
  pnpm --dir "$ROOT" install --frozen-lockfile --ignore-scripts
else
  npm --prefix "$ROOT" ci --ignore-scripts --no-audit --no-fund
fi

shopt -s nullglob
package_jsons=("$ROOT"/packages/*/package.json "$ROOT"/packages/p3stack/*/package.json)
for package_json in "${package_jsons[@]}"; do
  package_dir="${package_json%/package.json}"
  if [[ ! -f "$package_dir/package-lock.json" ]]; then
    # Dependency-free skills need no install. Other packages must commit a
    # lockfile rather than silently resolving fresh dependency versions.
    node -e '
      const fs = require("node:fs");
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
          .some(key => Object.keys(m[key] ?? {}).length)) {
        throw new Error(`Missing committed lockfile: ${process.argv[1]}`);
      }
    ' "$package_json"
    continue
  fi
  # Child lockfiles remain available for isolated standalone-package installs.
done
