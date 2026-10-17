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
if [[ "\${MV_SHIM_MODE:-}" == install || "\${MV_SHIM_MODE:-}" == install-and-restore ]] && [[ "\${2:-}" == */.pi-pocock-skills-sync.*/skills ]]; then
  exit 91
fi
if [[ "\${MV_SHIM_MODE:-}" == restore || "\${MV_SHIM_MODE:-}" == install-and-restore ]] && [[ "\${2:-}" == */.pi-pocock-skills-backup.*/skills ]]; then
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

# Duplicate names across upstream buckets must not select the first silently.
case_root="$(new_case ambiguous-upstream)"
mkdir -p "$case_root/vendor/matt-pocock/skills/productivity/research"
cp "$case_root/vendor/matt-pocock/skills/engineering/research/SKILL.md" "$case_root/vendor/matt-pocock/skills/productivity/research/SKILL.md"
expect_failure ambiguous-upstream "$case_root"
grep -Fq 'AMBIGUOUS upstream skill "research"' "$TMP/ambiguous-upstream.log" || fail 'ambiguous source was not diagnosed'

# Removing every source spelling for a required rule trips the drift guard.
case_root="$(new_case rule-drift)"
find "$case_root/vendor/matt-pocock/skills" -type f -name '*.md' -exec perl -pi -e 's/sub-agents/child-workers/g' {} +
expect_failure rule-drift "$case_root"

# Tracker rewrites and foreground collection used to bypass drift accounting.
for rule in tracker-precondition tracker-spec-source tracker-ticket subagent-review-collect; do
  case_root="$(new_case "$rule")"
  case "$rule" in
    tracker-precondition) source='The issue tracker should have been provided to you.' ;;
    tracker-spec-source) source='fetched via the workflow in the tracker doc.' ;;
    tracker-ticket) source='fetch it from the issue tracker and state its title' ;;
    subagent-review-collect) source='in the foreground' ;;
  esac
  SOURCE="$source" find "$case_root/vendor/matt-pocock/skills" -type f -name '*.md' -exec perl -0777 -pi -e 's/\Q$ENV{SOURCE}\E/upstream changed this wording/g' {} +
  expect_failure "$rule" "$case_root"
  grep -E "DRIFT +$rule +0 match" "$TMP/$rule.log" >/dev/null || fail "$rule did not trip its drift guard"
done

# Unrecognized harness spelling is rejected even when required rules still fire.
case_root="$(new_case untranslated)"
printf '\nUse the Skill tool for another task.\n' >> "$case_root/vendor/matt-pocock/skills/engineering/research/SKILL.md"
expect_failure untranslated "$case_root"
grep -Fq 'retain untranslated' "$TMP/untranslated.log" || fail 'untranslated wording was not diagnosed'

# A broken regex is an error, not a zero count (including optional rules).
case_root="$(new_case invalid-regex)"
perl -pi -e 's/^clear-to-new\|0\|[^|]*/clear-to-new|0|(/' "$case_root/scripts/sync.sh"
expect_failure invalid-regex "$case_root"
grep -Fq 'Unmatched (' "$TMP/invalid-regex.log" || fail 'invalid regex was hidden'

# Renaming the format reference must not overwrite an unexpected second source.
case_root="$(new_case glossary-collision)"
cp "$case_root/vendor/matt-pocock/skills/engineering/domain-modeling/GLOSSARY-FORMAT.md" "$case_root/vendor/matt-pocock/skills/engineering/domain-modeling/CONTEXT-FORMAT.md"
expect_failure glossary-collision "$case_root"

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
grep -Fq '[tdd](../tdd/SKILL.md)' "$case_root/skills/implement/SKILL.md" || fail 'TDD read has no dependency link'
grep -Fq '[code-review](../code-review/SKILL.md)' "$case_root/skills/implement/SKILL.md" || fail 'review read has no dependency link'
grep -Fq 'If no tracker is configured, ask for the ticket text' "$case_root/skills/implement/SKILL.md" || fail 'ticket handling assumes a configured tracker'
grep -Fq 'collect and verify both reports before aggregating' "$case_root/skills/code-review/SKILL.md" || fail 'foreground collection was not translated'
grep -Fq 'Search the repo for every file' "$case_root/skills/code-review/SKILL.md" || fail 'upstream standards discovery was lost'
grep -Fq 'what it catches and what it misses' "$case_root/skills/tdd/SKILL.md" || fail 'upstream seam tradeoffs were lost'
grep -Fq 'prove the mutation landed' "$case_root/skills/diagnosing-bugs/SKILL.md" || fail 'upstream mutation verification was lost'
grep -Fq '"yes" accepts your recommended answer' "$case_root/skills/grilling/SKILL.md" || fail 'upstream question guidance was lost'
grep -Fq '`orchestrator_capabilities`' "$case_root/skills/references/CHILD-DELEGATION.md" || fail 'T3 delegation branch is missing'
grep -Fq '[CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md)' "$case_root/skills/domain-modeling/SKILL.md" || fail 'format reference was not translated'
[ ! -e "$case_root/skills/domain-modeling/GLOSSARY-FORMAT.md" ] || fail 'upstream format filename leaked'
! grep -R -E 'GLOSSARY[.-]|Skill tool|in the foreground|workflow in the tracker doc' "$case_root/skills" || fail 'untranslated source leaked'
# Project/output paths and fenced examples are not bundled resources.
grep -Fq 'read `CONTEXT.md` (if it exists)' "$case_root/skills/tdd/SKILL.md" || fail 'project path was incorrectly rewritten'
grep -Fq '[Ordering](./src/ordering/CONTEXT.md)' "$case_root/skills/domain-modeling/CONTEXT-FORMAT.md" || fail 'fenced example was incorrectly rewritten'
(cd "$case_root" && ./scripts/sync.sh --check >"$TMP/success-check.log" 2>&1)
cp -a "$case_root/skills" "$TMP/first-generation"
(cd "$case_root" && ./scripts/sync.sh >"$TMP/success-repeat.log" 2>&1)
diff -r "$TMP/first-generation" "$case_root/skills" || fail 'repeated generation is not byte-identical'

# Legacy slash invocations remain supported, but are not required upstream.
case_root="$(new_case legacy-commands)"
printf '\nUse /tdd and /code-review.\n' >> "$case_root/vendor/matt-pocock/skills/engineering/implement/SKILL.md"
(cd "$case_root" && ./scripts/sync.sh >"$TMP/legacy-commands.log" 2>&1)
grep -Fq '[/skill:tdd](../tdd/SKILL.md)' "$case_root/skills/implement/SKILL.md" || fail 'legacy TDD command is not linked'
grep -Fq '[/skill:code-review](../code-review/SKILL.md)' "$case_root/skills/implement/SKILL.md" || fail 'legacy review command is not linked'

# The dependency closure is checked independently of invocation spelling.
case_root="$(new_case lost-dependency)"
perl -pi -e 's/Call the Skill tool with "tdd"/Use the testing helper/' "$case_root/vendor/matt-pocock/skills/engineering/implement/SKILL.md"
expect_failure lost-dependency "$case_root"
grep -Fq 'implement lost its tdd dependency link' "$TMP/lost-dependency.log" || fail 'lost dependency was not diagnosed'

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
if find "$case_root" -maxdepth 1 -type d -name '.pi-pocock-skills-backup.*' -print -quit | grep -q .; then
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
backup_dir="$(find "$case_root" -maxdepth 1 -type d -name '.pi-pocock-skills-backup.*' -print -quit)"
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

echo 'sync tests passed: mismatch, missing/ambiguous upstream, counted drift, untranslated output, invalid regex, glossary collision, preservation, semantic updates, determinism, legacy commands, dependencies, move recovery, arguments'
