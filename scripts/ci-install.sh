#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_VERSION="${1:?usage: scripts/ci-install.sh <locked|0.99.2>}"
case "$PI_VERSION" in
  locked|0.99.2) ;;
  *) printf 'Unsupported Pi version: %s\n' "$PI_VERSION" >&2; exit 2 ;;
esac

source "$ROOT/scripts/package-manager.sh"

# Each manager uses its own committed root workspace lockfile.
if [[ "$PACKAGE_MANAGER" == pnpm ]]; then
  pnpm --dir "$ROOT" install --frozen-lockfile --ignore-scripts
else
  npm --prefix "$ROOT" ci --ignore-scripts --no-audit --no-fund
fi

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
  # Child lockfiles remain available for isolated standalone-package installs.
done

if [[ "$PI_VERSION" == "0.99.2" && "$PACKAGE_MANAGER" == pnpm ]]; then
  # Temporary workspace overrides exercise the current runtime without changing
  # committed manifests or either lockfile. Restore even when installation fails.
  workspace_backup="$(mktemp)"
  cp "$ROOT/pnpm-workspace.yaml" "$workspace_backup"
  trap 'cp "$workspace_backup" "$ROOT/pnpm-workspace.yaml"; rm -f "$workspace_backup"' EXIT
  node --input-type=module - "$ROOT" "$PI_VERSION" <<'NODE'
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const [root, version] = process.argv.slice(2);
const { parse, stringify } = createRequire(`${root}/packages/agent-skills/package.json`)("yaml");
// Stable Pi matrix overrides must not downgrade the separate pinned Durable 1.x stack.
const names = new Set();
for (const dir of readdirSync(`${root}/packages`)) {
  const manifest = JSON.parse(readFileSync(`${root}/packages/${dir}/package.json`, "utf8"));
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (name.startsWith("@earendil-works/pi-")) names.add(name);
  }
}
const path = `${root}/pnpm-workspace.yaml`;
const workspace = parse(readFileSync(path, "utf8"));
if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) {
  throw new Error("Expected a workspace mapping");
}
const overrides = workspace.overrides ?? {};
if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
  throw new Error("Expected an overrides mapping");
}
for (const name of [...names].sort()) overrides[`${name}@<1.0.0`] = version;
writeFileSync(path, stringify({ ...workspace, overrides }));
NODE
  pnpm --dir "$ROOT" install --no-frozen-lockfile --lockfile=false --ignore-scripts
elif [[ "$PI_VERSION" == "0.99.2" ]]; then
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
    # Read the committed lock while applying unsaved runtime overrides. Ignoring
    # it re-resolves unrelated Durable 1.x dependencies and breaks pinned aliases.
    npm --prefix "$package_dir" install --ignore-scripts --no-save --package-lock=true --no-audit --no-fund "${requested[@]}"
  done
fi

# npm otherwise honors the SDK's vulnerable published shrinkwrap, even when the
# outer lock or an override names the patched dependency. No lifecycle hooks run.
node "$ROOT/scripts/patch-pi-host-security.mts"
