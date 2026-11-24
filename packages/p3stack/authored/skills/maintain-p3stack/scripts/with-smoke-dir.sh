#!/usr/bin/env bash
set +x
set -eu
umask 077
root=$(pwd -P)
[[ -f "$root/packages/p3stack/package.json" && $# -gt 0 ]] || { echo "Run from the repository root with a smoke command." >&2; exit 2; }
tmp=$(cd "${TMPDIR:-/tmp}" && pwd -P)
source_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
case "$source_dir" in '~') source_dir=$HOME ;; '~/'*) source_dir="$HOME/${source_dir#\~/}" ;; esac
for protected in "$root" "$HOME/.pi/agent" "$source_dir"; do
  [[ -d "$protected" ]] || continue
  physical=$(cd -- "$protected" && pwd -P)
  case "$tmp/" in "${physical%/}/"*) echo "Choose a temporary directory outside the checkout and real agent settings." >&2; exit 2;; esac
done
fixture=$(mktemp -d "$tmp/p3stack-smoke.XXXXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -f "$source_dir/auth.json" ]]; then install -m 600 "$source_dir/auth.json" "$fixture/auth.json"; fi
node -e 'console.log(JSON.stringify({packages:[process.argv[1]]}))' "$root/packages/p3stack" > "$fixture/settings.json"
PI_CODING_AGENT_DIR="$fixture" "$@"
