#!/usr/bin/env bash
# Link repo-owned Pi configuration. --check is read-only.
# Existing files/links are backed up before replacement; their contents are
# never silently imported into the canonical repo copies.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
FILES=(settings.json models.json mcp.json subagents.json)

check_only=0
case "${1:-}" in
  '') [[ $# -eq 0 ]] || { echo "Usage: $0 [--check]" >&2; exit 2; } ;;
  --check) [[ $# -eq 1 ]] || { echo "Usage: $0 [--check]" >&2; exit 2; }; check_only=1 ;;
  *) echo "Usage: $0 [--check]" >&2; exit 2 ;;
esac

# Validate every source and destination before changing any links.
for name in "${FILES[@]}"; do
  source="$REPO_DIR/$name"
  if [[ ! -f "$source" ]] || ! jq -e -s 'length == 1 and (.[0] | type == "object")' "$source" >/dev/null; then
    echo "INVALID $source (expected a JSON object)" >&2
    exit 1
  fi
  target="$AGENT_DIR/$name"
  if [[ -d "$target" && ! -L "$target" ]]; then
    echo "REFUSE  $target is a directory" >&2
    exit 1
  fi
done

# BSD mv exits 64 for -T and already replaces a symlink to a directory.
# GNU mv needs -T for that replace. A no-operand probe exits 1 there.
mv_replace=(-T -f)
if (( ! check_only )); then
  mv -T >/dev/null 2>&1 || mv_probe=$?
  if [[ "${mv_probe:-0}" -eq 64 ]]; then
    mv_replace=(-f)
  fi
fi

rc=0
for name in "${FILES[@]}"; do
  want="$REPO_DIR/$name"
  target="$AGENT_DIR/$name"
  if [[ -L "$target" && "$(readlink -f "$target")" == "$want" ]]; then
    echo "ok      $target"
    continue
  fi
  if (( check_only )); then
    echo "DRIFT   $target (expected link to $want)"
    rc=1
    continue
  fi

  mkdir -p "$AGENT_DIR"
  if [[ -e "$target" || -L "$target" ]]; then
    backup_dir="$(mktemp -d "$AGENT_DIR/pi-config-backup.XXXXXXXX")"
    cp -a -- "$target" "$backup_dir/$name"
    echo "backup  $target -> $backup_dir/$name"
  fi

  # Rename a new symlink over the old path without an unlink/relink gap.
  temporary="$(mktemp -d "$AGENT_DIR/.pi-link.XXXXXXXX")"
  trap 'rm -rf -- "$temporary"' EXIT
  ln -s "$want" "$temporary/$name"
  mv "${mv_replace[@]}" -- "$temporary/$name" "$target"
  rmdir "$temporary"
  trap - EXIT
  echo "linked  $target -> $want"
done
exit "$rc"
