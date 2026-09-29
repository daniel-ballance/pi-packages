#!/usr/bin/env bash
# Shared by check.sh and ci-install.sh. Explicit selection wins, then the
# invoking package manager, then the installed dependency layout.
if [[ -z "${PACKAGE_MANAGER:-}" ]]; then
  case "${npm_config_user_agent:-}" in
    pnpm/*) PACKAGE_MANAGER=pnpm ;;
    npm/*) PACKAGE_MANAGER=npm ;;
    *)
      if [[ -f "$ROOT/node_modules/.modules.yaml" ]]; then
        PACKAGE_MANAGER=pnpm
      else
        PACKAGE_MANAGER=npm
      fi
      ;;
  esac
fi
case "$PACKAGE_MANAGER" in
  npm|pnpm) ;;
  *) printf 'Unsupported PACKAGE_MANAGER: %s (expected npm or pnpm)\n' "$PACKAGE_MANAGER" >&2; exit 2 ;;
esac
export PACKAGE_MANAGER
