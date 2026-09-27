#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

new_case() {
  local name="$1" case_root="$TMP/$1"
  mkdir -p "$case_root/scripts" "$case_root/vendor"
  cp -a "$ROOT/scripts/sync.sh" "$case_root/scripts/"
  cp -a "$ROOT/skills" "$case_root/skills"
  cp -a "$ROOT/vendor/matt-pocock" "$case_root/vendor/matt-pocock"
  # Copy only sync inputs: the package now also has installed CLI dependencies.
  # The copied submodule metadata points back at the real checkout. Tests only
  # need its files, so keep this fixture independent of Git/network state.
  rm -rf "$case_root/vendor/matt-pocock/.git"
  printf '%s\n' "$case_root"
}

expect_failure() {
  local label="$1" root="$2" log="$TMP/$1.log"
  if (cd "$root" && ./scripts/sync.sh --check >"$log" 2>&1); then
    cat "$log" >&2
    fail "$label unexpectedly passed"
  fi
}

make_mv_shim() {
  local mode="$1" dir real_mv
  dir="$TMP/mv-$mode"
  real_mv="$(type -P mv)"
  mkdir -p "$dir"
  cat > "$dir/mv" <<SHIM
#!/usr/bin/env bash
if [[ "\${MV_SHIM_MODE:-}" == install || "\${MV_SHIM_MODE:-}" == install-and-restore ]] && [[ "\${2:-}" == */.agent-skills-sync.*/skills ]]; then
  exit 91
fi
if [[ "\${MV_SHIM_MODE:-}" == restore || "\${MV_SHIM_MODE:-}" == install-and-restore ]] && [[ "\${2:-}" == */.agent-skills-backup.*/skills ]]; then
  exit 92
fi
exec "$real_mv" "\$@"
SHIM
  chmod +x "$dir/mv"
  printf '%s\n' "$dir"
}

# A committed/generated mismatch is reported without touching the committed tree.
case_root="$(new_case mismatch)"
printf '\ncommitted marker\n' >> "$case_root/skills/grilling/SKILL.md"
before="$(sha256sum "$case_root/skills/grilling/SKILL.md")"
expect_failure mismatch "$case_root"
after="$(sha256sum "$case_root/skills/grilling/SKILL.md")"
[ "$before" = "$after" ] || fail 'mismatch check changed committed output'

# An allowlisted upstream skill disappearing is a hard failure.
case_root="$(new_case missing-upstream)"
rm -rf "$case_root/vendor/matt-pocock/skills/engineering/research"
expect_failure missing-upstream "$case_root"

# Removing every source spelling for a required rule trips the drift guard.
case_root="$(new_case rule-drift)"
find "$case_root/vendor/matt-pocock/skills" -type f -name '*.md' -exec perl -pi -e 's/sub-agents/child-workers/g' {} +
expect_failure rule-drift "$case_root"

# Normal sync also preserves the committed tree when staged validation fails.
case_root="$(new_case preservation)"
printf '\npreserve this output\n' >> "$case_root/skills/grilling/SKILL.md"
before="$(sha256sum "$case_root/skills/grilling/SKILL.md")"
rm -rf "$case_root/vendor/matt-pocock/skills/engineering/research"
if (cd "$case_root" && ./scripts/sync.sh >"$TMP/preservation.log" 2>&1); then
  cat "$TMP/preservation.log" >&2
  fail 'preservation sync unexpectedly passed'
fi
after="$(sha256sum "$case_root/skills/grilling/SKILL.md")"
[ "$before" = "$after" ] || fail 'failed sync replaced committed output'
grep -Fq 'preserve this output' "$case_root/skills/grilling/SKILL.md" || fail 'preserved marker disappeared'

# A valid run replaces stale output and leaves a checkable translation.
case_root="$(new_case success)"
printf '\nstale output\n' >> "$case_root/skills/grilling/SKILL.md"
(cd "$case_root" && ./scripts/sync.sh >"$TMP/success.log" 2>&1)
! grep -Fq 'stale output' "$case_root/skills/grilling/SKILL.md" || fail 'successful sync kept stale output'
[ -f "$case_root/skills/references/CHILD-DELEGATION.md" ] || fail 'shared child guidance was not generated'
# Resource pointers must be discoverable by the Markdown reference graph.
grep -Fq '[HITL loop template](scripts/hitl-loop.template.sh)' "$case_root/skills/diagnosing-bugs/SKILL.md" || fail 'HITL script has no explicit resource link'
grep -Fq '[grilling](../grilling/SKILL.md)' "$case_root/skills/grill-with-docs/SKILL.md" || fail 'sibling skill has no explicit resource link'
grep -Fq '[child delegation guidance](../references/CHILD-DELEGATION.md)' "$case_root/skills/research/SKILL.md" || fail 'shared guidance has no explicit resource link'
grep -Fq '[/skill:tdd](../tdd/SKILL.md)' "$case_root/skills/implement/SKILL.md" || fail 'TDD command has no dependency link'
grep -Fq '[/skill:code-review](../code-review/SKILL.md)' "$case_root/skills/implement/SKILL.md" || fail 'review command has no dependency link'
# Project/output paths and fenced examples are not bundled resources.
grep -Fq 'read `CONTEXT.md` (if it exists)' "$case_root/skills/tdd/SKILL.md" || fail 'project path was incorrectly rewritten'
grep -Fq '[Ordering](./src/ordering/CONTEXT.md)' "$case_root/skills/domain-modeling/CONTEXT-FORMAT.md" || fail 'fenced example was incorrectly rewritten'
(cd "$case_root" && ./scripts/sync.sh --check >"$TMP/success-check.log" 2>&1)

# A failed install move restores the old tree through the EXIT trap.
case_root="$(new_case install-move-failure)"
printf '\nrecoverable output\n' >> "$case_root/skills/grilling/SKILL.md"
before="$(sha256sum "$case_root/skills/grilling/SKILL.md")"
shim="$(make_mv_shim install)"
if (cd "$case_root" && PATH="$shim:$PATH" MV_SHIM_MODE=install ./scripts/sync.sh >"$TMP/install-move-failure.log" 2>&1); then
  cat "$TMP/install-move-failure.log" >&2
  fail 'install move failure unexpectedly passed'
fi
after="$(sha256sum "$case_root/skills/grilling/SKILL.md")"
[ "$before" = "$after" ] || fail 'install move failure lost the previous output'
if find "$case_root" -maxdepth 1 -type d -name '.agent-skills-backup.*' -print -quit | grep -q .; then
  fail 'successful recovery left an old backup directory'
fi

# If recovery itself fails, retain the old tree at an explicit recovery path.
case_root="$(new_case restore-failure)"
printf '\nretained recovery output\n' >> "$case_root/skills/grilling/SKILL.md"
shim="$(make_mv_shim install-and-restore)"
if (cd "$case_root" && PATH="$shim:$PATH" MV_SHIM_MODE=install-and-restore ./scripts/sync.sh >"$TMP/restore-failure.log" 2>&1); then
  cat "$TMP/restore-failure.log" >&2
  fail 'restore failure unexpectedly passed'
fi
backup_dir="$(find "$case_root" -maxdepth 1 -type d -name '.agent-skills-backup.*' -print -quit)"
[ -n "$backup_dir" ] || fail 'failed recovery did not retain a backup directory'
grep -Fq 'retained recovery output' "$backup_dir/skills/grilling/SKILL.md" || fail 'retained recovery copy is incomplete'
grep -Fq 'recovery copy retained at' "$TMP/restore-failure.log" || fail 'restore failure did not report the recovery path'

# Unknown or extra arguments fail before any generation.
case_root="$(new_case arguments)"
if (cd "$case_root" && ./scripts/sync.sh --bogus >"$TMP/arguments.log" 2>&1); then
  fail 'unknown argument unexpectedly passed'
fi
if (cd "$case_root" && ./scripts/sync.sh --check extra >"$TMP/arguments-extra.log" 2>&1); then
  fail 'extra argument unexpectedly passed'
fi

echo 'sync tests passed: mismatch, missing upstream, rule drift, preservation, success, move failure recovery, argument validation'
