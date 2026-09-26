#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_VERSION="${1:?usage: scripts/ci-install.sh <0.85.1|0.87.1>}"
case "$PI_VERSION" in
  0.85.1|0.87.1) ;;
  *) printf 'Unsupported Pi version: %s\n' "$PI_VERSION" >&2; exit 2 ;;
esac

shopt -s nullglob
package_jsons=("$ROOT"/packages/*/package.json)
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
  printf '\n== installing %s (%s) ==\n' "$(basename "$package_dir")" "$PI_VERSION"
  npm --prefix "$package_dir" ci --ignore-scripts --no-audit --no-fund
done

if [[ "$PI_VERSION" == "0.87.1" ]]; then
  for package_json in "${package_jsons[@]}"; do
    package_dir="${package_json%/package.json}"
    mapfile -t pi_dependencies < <(
      node -e '
        const fs = require("node:fs");
        const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        for (const name of Object.keys(manifest.peerDependencies ?? {})) {
          if (name.startsWith("@earendil-works/pi-")) console.log(name);
        }
      ' "$package_json"
    )
    if ((${#pi_dependencies[@]} == 0)); then
      continue
    fi
    requested=()
    for dependency in "${pi_dependencies[@]}"; do
      requested+=("$dependency@$PI_VERSION")
    done
    printf '\n== current Pi runtime in %s ==\n' "$(basename "$package_dir")"
    npm --prefix "$package_dir" install --ignore-scripts --no-save --package-lock=false --no-audit --no-fund "${requested[@]}"
  done
fi
