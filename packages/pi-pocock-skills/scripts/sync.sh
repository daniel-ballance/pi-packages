#!/usr/bin/env bash
#
# Translate upstream Matt Pocock skills into Pi-native skills.
#
#   ./scripts/sync.sh          regenerate skills/ from vendor/matt-pocock
#   ./scripts/sync.sh --check  regenerate to a temp dir and diff against skills/
#
# Never hand-edit skills/. Edit the rules below, then re-run.
# See AGENTS.md for the contract and the reason each rule exists.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./scripts/sync.sh [--check]

  (no argument)  regenerate skills/ from vendor/matt-pocock
  --check        validate a fresh translation and compare it with skills/
USAGE
}

case "$#:$*" in
  0:) MODE=sync ;;
  1:sync) MODE=sync ;;
  1:--check) MODE=check ;;
  1:-h|1:--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/matt-pocock"
OUT="$ROOT/skills"
OUT_PARENT="$ROOT"

# ---------------------------------------------------------------------------
# Allowlist. Only these skills are ever copied, so a new upstream skill cannot
# arrive silently. This is the dependency closure of the eight skills we adopted:
# grill-with-docs pulls grilling + domain-modeling, implement pulls tdd +
# code-review, tdd pulls codebase-design.
# ---------------------------------------------------------------------------
ALLOW=(
  grilling
  grill-with-docs
  domain-modeling
  codebase-design
  code-review
  writing-for-agents
  diagnosing-bugs
  research
  wait-what
  implement
  tdd
)

# ---------------------------------------------------------------------------
# Translation rules: id | min_total | perl_pattern | replacement
#
# min_total is a drift tripwire, counted across the whole generated tree. A rule
# that fires zero times means upstream reworded the sentence and our translation
# silently stopped applying. The script fails loudly on that.
# ---------------------------------------------------------------------------
RULES_FILE="$(mktemp)"
trap 'rm -f "$RULES_FILE"' EXIT
cat >"$RULES_FILE" <<'RULES'
skill-tool-twice|1|Call the Skill tool twice, for "([^"]+)" and "([^"]+)"\.|Read `../$1/SKILL.md` and `../$2/SKILL.md`, and follow both.
skill-tool-call-upper|1|Call the Skill tool with "([^"]+)"|Read `../$1/SKILL.md`
skill-tool-call-lower|1|call the Skill tool with "([^"]+)"|read `../$1/SKILL.md`
subagent-dispatch|1|Finding _facts_ is your job, never the user's\. When a frontier question needs a fact from the environment \(filesystem, tools, etc\.\), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself\. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now\. The _decisions_ are the user's: put each to them and wait\.|Facts are your job, never the user's. For a non-trivial environment investigation, when child and retrieval tools are available, spawn a bounded child to gather it. For a trivial lookup, or when those tools are unavailable, inspect it directly. Ask independent frontier questions now and wait only for dependent child work. Decisions remain the user's: ask and wait.
subagent-plural|1|sub-agents|subagents
subagent-singular|1|sub-agent|subagent
subagent-spawn-many|1|Spawn 3\+ subagents in parallel|Spawn up to 3 parallel children with `subagent_spawn`, within the catalog's live-child limit; then `subagent_wait`, `subagent_read`, and `subagent_close` each child
subagent-spawn-review|1|Spawn both subagents in parallel|Spawn both reviewers with `subagent_spawn`, then `subagent_wait`
subagent-review-collect|1|Issue both subagent calls together, in the foreground, and aggregate the reports they return\.|Spawn both reviewers before waiting; collect and verify both reports before aggregating them.
subagent-background|1|Spin up a \*\*background agent\*\* to do the research, so you keep working while it reads\.|For substantial research, when child and retrieval tools are available, spawn a bounded child so you can keep working while it reads. For a trivial lookup, or when those tools are unavailable, research directly.
subagent-design-twice|1|spin up parallel subagents|spawn parallel children with `subagent_spawn`
clear-to-new|0|(?<![\w/-])/clear\b|/new
arg-hint|0|^argument-hint:.*\n||
hitl-resource-link|1|`scripts/hitl-loop\.template\.sh`|[HITL loop template](scripts/hitl-loop.template.sh)
skill-resource-link|1|`\.\./([a-z0-9-]+)/SKILL\.md`|[$1](../$1/SKILL.md)
tdd-command-link|0|(?<![\w./-])/tdd\b|[/tdd](../tdd/SKILL.md)
review-command-link|0|(?<![\w./-])/code-review\b|[/code-review](../code-review/SKILL.md)
tracker-precondition|1|The issue tracker should have been provided to you\. If not, tell the user to run `/setup-matt-pocock-skills`\.|The spec is whatever the conversation already names: a package design doc (`docs/<name>.md`), the package `README.md`, `ROADMAP.md`, or a spec file under `docs/`. If nothing is named, ask the user where the spec is. These repos keep specs in the repo, not in an issue tracker.
tracker-spec-source|1|1\. Issue references in the commit messages \(`\#123`, `Closes \#45`, GitLab `!67`, etc\.\), fetched via the workflow in the tracker doc\.|1. A spec path named in the conversation or commit messages.
tracker-ticket|1|If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting\. If the reference is ambiguous, ask\.|If the user passes a ticket reference, use the repo's documented tracker workflow to fetch it and state its title before starting. If no tracker is configured, ask for the ticket text; if the reference is ambiguous, ask.
glossary-convention|1|\bGLOSSARY(?=[.-])|CONTEXT
glossary-map-heading|1|\# Glossary Map|# Context Map
RULES

# Slash-command namespacing: /name -> /skill:name for every skill we might name.
SLASH_SKILLS=(tdd code-review grill-me grill-with-docs grilling domain-modeling codebase-design
              diagnosing-bugs research wait-what implement to-spec to-tickets triage wayfinder
              improve-codebase-architecture prototype handoff teach to-questionnaire
              writing-for-agents setup-matt-pocock-skills)

# This is a shared reference for the translated child workflows. Keep the
# mechanics here rather than duplicating them in every generated skill.
CHILD_POINTER='Read [child delegation guidance](../references/CHILD-DELEGATION.md) before using child delegation.'

CHILD_GUIDANCE=$(cat <<'GUIDANCE'
# Child delegation

Use a child for bounded, non-trivial work. Follow the branch for the current host; skill prose naming `subagent_*` tools describes the Pi CLI branch.

## T3 Code

Use T3's `orchestrator_capabilities` to choose an available exact provider/model, then `delegate_task` with a bounded task and explicit working directory in the prompt. Retain each `taskId`. Prefer async delegation; issue independent tasks before waiting. Completion wakes the parent, so end the turn when nothing else is ready. Use `task_status` when a result is needed mid-turn, and `task_cancel` to interrupt active work. Verify returned reports and artifacts before aggregating. A new review round uses a new `delegate_task` call with the original brief, prior findings, responses, and unresolved objections, not a message to the backing child thread. Use a distinct `clientRequestId` per round, stable across retries. Top-level threads are not delegated tasks.

## Pi CLI

First call `subagent_catalog` to see usable exact models, tools, and the live-child limit. Compose one focused child with `subagent_spawn`, selecting only the tools it needs and an explicit task and working directory. Parallelize only independent tasks and stay within the catalog limit. With nothing else to do this turn, end your turn; finished children's reports wake you. Call `subagent_wait` for the selected IDs only when your next step in this turn needs the results. It returns their new reports. Inspect replies, errors, and requested artifacts, and `subagent_read` a child whose `unread` is above 0. Verify the result; completion is not proof. Call `subagent_close` for every child after reading it, including failed work.

If catalog or spawn is unavailable, or the task has no retrieval tools available to the child, do the work directly or state the limitation. Do not assume a fallback model or child composition: unavailable catalog entries are not silently substituted.
GUIDANCE
)

declare -A COUNTS=()
MISSING=0

find_src() {
  local name="$1" d found=""
  for d in "$VENDOR"/skills/*/"$name"; do
    [ -f "$d/SKILL.md" ] || continue
    if [ -n "$found" ]; then
      printf '  AMBIGUOUS upstream skill "%s": %s and %s\n' "$name" "$found" "$d" >&2
      return 1
    fi
    found="$d"
  done
  [ -n "$found" ] || return 1
  printf '%s\n' "$found"
}

count_matches() {
  local pat="$1" dir="$2" total=0 c
  while IFS= read -r -d '' f; do
    c="$(P="$pat" perl -0777 -ne 'my $p=$ENV{P}; my $n = () = $_ =~ /$p/gm; print $n' "$f")" || return 1
    total=$((total + c))
  done < <(find "$dir" -name '*.md' -print0)
  echo "$total"
}

apply_to_tree() {
  local dir="$1" pat="$2" rep="$3"
  while IFS= read -r -d '' f; do
    P="$pat" R="$rep" perl -0777 -pi -e '
      my $p = $ENV{P};
      my $r = $ENV{R};
      s{$p}{ do { my @c = ($1, $2, $3); my $t = $r; $t =~ s/\$(\d)/(defined $c[$1-1] ? $c[$1-1] : "")/ge; $t } }gem;
    ' "$f"
  done < <(find "$dir" -name '*.md' -print0)
}

write_child_guidance() {
  local target="$1"
  mkdir -p -- "$target/references"
  printf '%s\n' "$CHILD_GUIDANCE" > "$target/references/CHILD-DELEGATION.md"
}

inject_child_pointer() {
  local file="$1"
  [ -f "$file" ] || return 0
  grep -Fq "$CHILD_POINTER" "$file" && return 0
  P="$CHILD_POINTER" perl -0777 -pi -e '
    my $p = $ENV{P};
    if (index($_, $p) < 0) {
      s/\A(---\n.*?\n---\n)/$1 . "\n" . $p . "\n"/se or die "missing skill frontmatter\n";
    }
  ' "$file"
}

prepend_child_pointer() {
  local file="$1" tmp
  [ -f "$file" ] || return 0
  grep -Fq "$CHILD_POINTER" "$file" && return 0
  tmp="$file.tmp.$$"
  {
    printf '%s\n\n' "$CHILD_POINTER"
    cat "$file"
  } > "$tmp"
  mv -- "$tmp" "$file"
}

run_translation() {
  local target="$1" name src id min pat rep
  rm -rf -- "$target"
  mkdir -p -- "$target"
  MISSING=0
  COUNTS=()

  for name in "${ALLOW[@]}"; do
    if ! src="$(find_src "$name")"; then
      printf '  MISSING upstream skill "%s" not found\n' "$name" >&2
      MISSING=1
      continue
    fi
    cp -R -- "$src" "$target/$name"
    # Pi never reads agents/openai.yaml. disable-model-invocation in SKILL.md is
    # the supported equivalent and is already present where it matters.
    rm -rf -- "$target/$name/agents"
  done

  # Keep the local CONTEXT.md contract, including the bundled format reference.
  # Rename before rewriting links; a collision is drift, not permission to overwrite.
  if [ -e "$target/domain-modeling/GLOSSARY-FORMAT.md" ]; then
    if [ -e "$target/domain-modeling/CONTEXT-FORMAT.md" ]; then
      echo '  INVALID upstream: both glossary and context format resources exist' >&2
      return 1
    fi
    mv -- "$target/domain-modeling/GLOSSARY-FORMAT.md" "$target/domain-modeling/CONTEXT-FORMAT.md"
  fi

  write_child_guidance "$target"

  # Count then apply, one rule at a time, in order. Rules that rewrite text an
  # earlier rule produced (sub-agent -> subagent -> spawn a child) must be
  # counted at their own point in the chain, not against the original tree.
  while IFS='|' read -r id min pat rep; do
    [ -z "${id:-}" ] && continue
    COUNTS[$id]="$(count_matches "$pat" "$target")"
    apply_to_tree "$target" "$pat" "$rep"
  done < "$RULES_FILE"

  # Counted tracker rules above run BEFORE slash-namespacing, which would
  # otherwise change the source command spelling before it can match.

  # Slash-command namespacing.
  for s in "${SLASH_SKILLS[@]}"; do
    apply_to_tree "$target" "(?<![\\w./-])/$s\b" "/skill:$s"
  done

  # Keep child mechanics reusable while making the pointer visible at the point
  # where each translated child workflow asks for delegation.
  inject_child_pointer "$target/grilling/SKILL.md"
  inject_child_pointer "$target/research/SKILL.md"
  inject_child_pointer "$target/code-review/SKILL.md"
  prepend_child_pointer "$target/codebase-design/DESIGN-IT-TWICE.md"
}

report_rules() {
  local fail=0 id min n
  echo
  echo "Rule accounting (total matches across generated tree)"
  while IFS='|' read -r id min pat rep; do
    [ -z "${id:-}" ] && continue
    n="${COUNTS[$id]:-0}"
    if [ "$n" -lt "$min" ]; then
      printf '  DRIFT  %-24s %s match(es), expected >= %s. Upstream reworded it.\n' "$id" "$n" "$min"
      fail=1
    else
      printf '  ok     %-24s %s match(es)\n' "$id" "$n"
    fi
  done < "$RULES_FILE"
  return "$fail"
}

validate_output() {
  local target="$1" fail=0 name
  for name in "${ALLOW[@]}"; do
    if [ ! -f "$target/$name/SKILL.md" ]; then
      printf '  INVALID output: %s/SKILL.md is missing\n' "$name" >&2
      fail=1
    fi
  done
  if find "$target" -type l -print -quit | grep -q .; then
    echo '  INVALID output: generated skills contain a symlink' >&2
    fail=1
  fi
  if grep -R -n -E 'docs/agents/issue-tracker\.md|The issue tracker should have been provided|workflow in the tracker doc' "$target" >/dev/null 2>&1; then
    echo '  INVALID output: generated skills retain an issue-tracker prerequisite' >&2
    fail=1
  fi
  if grep -R -n -E 'Skill tool|in the foreground|GLOSSARY[.-]' "$target" >/dev/null 2>&1; then
    echo '  INVALID output: generated skills retain untranslated harness or glossary wording' >&2
    fail=1
  fi
  # The implementation wrapper must keep its dependency closure even if upstream
  # changes from slash commands to another invocation spelling.
  for name in tdd code-review; do
    if ! grep -Fq "(../$name/SKILL.md)" "$target/implement/SKILL.md"; then
      printf '  INVALID output: implement lost its %s dependency link\n' "$name" >&2
      fail=1
    fi
  done
  return "$fail"
}

validate_translation() {
  local target="$1" fail=0
  if ! report_rules; then
    fail=1
  fi
  if [ "$MISSING" -ne 0 ]; then
    echo '  INVALID output: an allowlisted upstream skill is missing' >&2
    fail=1
  fi
  if ! validate_output "$target"; then
    fail=1
  fi
  return "$fail"
}

print_upstream_pin() {
  local pin
  if pin="$(git -C "$VENDOR" log --oneline -1 2>/dev/null)"; then
    echo "$pin"
  else
    echo '(unavailable: upstream is not a Git checkout)'
  fi
}

TMP="$(mktemp -d "$OUT_PARENT/.pi-pocock-skills-sync.XXXXXX")"
BACKUP_DIR=""
INSTALL_MOVED=0

cleanup_backup() {
  local saved="$BACKUP_DIR/skills"
  [ -n "$BACKUP_DIR" ] || return 0

  if [ "$INSTALL_MOVED" -eq 1 ]; then
    if rm -rf -- "$BACKUP_DIR"; then
      BACKUP_DIR=""
    else
      echo "Installed skills/, but could not delete the old backup; retained at $saved" >&2
    fi
    return 0
  fi

  if { [ ! -e "$OUT" ] && [ ! -L "$OUT" ]; } && { [ -e "$saved" ] || [ -L "$saved" ]; }; then
    if mv -- "$saved" "$OUT"; then
      echo "Restored previous skills/ after failed replacement." >&2
      if rm -rf -- "$BACKUP_DIR"; then
        BACKUP_DIR=""
      else
        echo "Previous skills/ restored; backup directory retained at $BACKUP_DIR" >&2
      fi
    else
      echo "Could not restore previous skills/; recovery copy retained at $saved" >&2
    fi
  elif { [ -e "$OUT" ] || [ -L "$OUT" ]; } && { [ ! -e "$saved" ] && [ ! -L "$saved" ]; }; then
    # Moving the old tree failed before a recovery copy was made.
    if rm -rf -- "$BACKUP_DIR"; then
      BACKUP_DIR=""
    fi
  elif [ -e "$saved" ] || [ -L "$saved" ]; then
    echo "Previous skills/ backup retained at $saved; output path is occupied." >&2
  else
    if rm -rf -- "$BACKUP_DIR"; then
      BACKUP_DIR=""
    else
      echo "Backup directory retained at $BACKUP_DIR" >&2
    fi
  fi
}

cleanup() {
  rm -rf -- "$TMP" || true
  cleanup_backup
  rm -f -- "$RULES_FILE" || true
}
trap cleanup EXIT

if [ "$MODE" = check ]; then
  echo "Checking generated output against committed skills/"
  run_translation "$TMP/skills"
  status=0
  if ! validate_translation "$TMP/skills"; then
    status=1
  fi
  echo
  if diff -rq -- "$OUT" "$TMP/skills" >/dev/null 2>&1; then
    echo "skills/ is up to date with upstream + rules"
  else
    echo "skills/ differs from a fresh translation. Re-run ./scripts/sync.sh"
    diff -rq -- "$OUT" "$TMP/skills" || true
    status=1
  fi
  echo
  echo "Upstream pin:"
  print_upstream_pin
  exit "$status"
fi

echo "Regenerating skills/ from vendor/matt-pocock"
run_translation "$TMP/skills"
if ! validate_translation "$TMP/skills"; then
  echo 'Refusing to replace committed skills/; staged output failed validation.' >&2
  exit 1
fi

# Swap only after generation, drift checks, allowlist checks, and output checks
# all pass. Restore the old tree if the final move itself fails.
BACKUP_DIR="$(mktemp -d "$OUT_PARENT/.pi-pocock-skills-backup.XXXXXX")"
if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  mv -- "$OUT" "$BACKUP_DIR/skills"
fi
if mv -- "$TMP/skills" "$OUT"; then
  INSTALL_MOVED=1
  cleanup_backup
else
  status=$?
  echo 'Failed to replace skills/; the previous output remains staged for recovery.' >&2
  exit "$status"
fi

echo
echo "Upstream pin:"
print_upstream_pin
