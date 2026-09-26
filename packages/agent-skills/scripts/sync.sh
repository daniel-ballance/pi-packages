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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/matt-pocock"
OUT="$ROOT/skills"
MODE="${1:-sync}"

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
skill-tool-call-upper|0|Call the Skill tool with "([^"]+)"|Read `../$1/SKILL.md`
skill-tool-call-lower|1|call the Skill tool with "([^"]+)"|read `../$1/SKILL.md`
subagent-plural|1|sub-agents|subagents
subagent-singular|1|sub-agent|subagent
subagent-spawn-review|1|Spawn both subagents in parallel|Spawn both reviewers with `subagent_spawn`, then `subagent_wait`
subagent-background|1|Spin up a \*\*background agent\*\*|Spawn a child with `subagent_spawn`
subagent-dispatch|1|dispatch a subagent to find it|spawn a child with `subagent_spawn` to find it
subagent-design-twice|1|spin up parallel subagents|spawn parallel children with `subagent_spawn`
clear-to-new|0|(?<![\w/-])/clear\b|/new
arg-hint|0|^argument-hint:.*\n||
RULES

# Slash-command namespacing: /name -> /skill:name for every skill we might name.
SLASH_SKILLS=(tdd code-review grill-me grill-with-docs grilling domain-modeling codebase-design
              diagnosing-bugs research wait-what implement to-spec to-tickets triage wayfinder
              improve-codebase-architecture prototype handoff teach to-questionnaire
              writing-for-agents setup-matt-pocock-skills)

# code-review's tracker dependency has no analogue here: these repos keep specs
# in repo docs, not in an issue tracker.
TRACKER_OLD='The issue tracker should have been provided to you. If `docs/agents/issue-tracker.md` is missing, tell the user to run `/setup-matt-pocock-skills`.'
TRACKER_NEW='The spec is whatever the conversation already names: a package design doc (`docs/<name>.md`), the package `README.md`, `ROADMAP.md`, or a spec file under `docs/`. If nothing is named, ask the user where the spec is. These repos keep specs in the repo, not in an issue tracker.'

declare -A COUNTS=()

find_src() {
  local name="$1" d
  for d in "$VENDOR"/skills/*/"$name"; do
    [ -f "$d/SKILL.md" ] && { echo "$d"; return 0; }
  done
  return 1
}

count_matches() {
  local pat="$1" dir="$2" total=0 c
  while IFS= read -r -d '' f; do
    c="$(P="$pat" perl -0777 -ne 'my $p=$ENV{P}; my $n = () = $_ =~ /$p/gm; print $n' "$f" 2>/dev/null || echo 0)"
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

# Literal (non-regex) replacement. \Q...\E inside an interpolated variable is not
# reliably honoured, so quote the metacharacters explicitly.
apply_literal_to_tree() {
  local dir="$1" lit="$2" rep="$3"
  while IFS= read -r -d '' f; do
    L="$lit" R="$rep" perl -0777 -pi -e '
      my $p = quotemeta($ENV{L});
      my $r = $ENV{R};
      s{$p}{$r}gm;
    ' "$f"
  done < <(find "$dir" -name '*.md' -print0)
}

run_translation() {
  local target="$1" name src id min pat rep
  rm -rf "$target"
  mkdir -p "$target"

  for name in "${ALLOW[@]}"; do
    if ! src="$(find_src "$name")"; then
      printf '  MISSING upstream skill "%s" not found\n' "$name" >&2
      MISSING=1
      continue
    fi
    cp -R "$src" "$target/$name"
    # Pi never reads agents/openai.yaml. disable-model-invocation in SKILL.md is
    # the supported equivalent and is already present where it matters.
    rm -rf "$target/$name/agents"
  done

  # Count then apply, one rule at a time, in order. Rules that rewrite text an
  # earlier rule produced (sub-agent -> subagent -> spawn a child) must be
  # counted at their own point in the chain, not against the original tree.
  while IFS='|' read -r id min pat rep; do
    [ -z "${id:-}" ] && continue
    COUNTS[$id]="$(count_matches "$pat" "$target")"
    apply_to_tree "$target" "$pat" "$rep"
  done < "$RULES_FILE"

  # Tracker swap runs BEFORE slash-namespacing, or its literal source text has
  # already been rewritten and will never match.
  apply_literal_to_tree "$target" "$TRACKER_OLD" "$TRACKER_NEW"

  # Slash-command namespacing.
  for s in "${SLASH_SKILLS[@]}"; do
    apply_to_tree "$target" "(?<![\\w./-])/$s\b" "/skill:$s"
  done
}

report_rules() {
  local fail=0 id min n
  echo
  echo "Rule accounting (total matches across generated tree)"
  while IFS='|' read -r id min pat rep; do
    [ -z "${id:-}" ] && continue
    n="${COUNTS[$id]:-0}"
    if [ "$n" -eq 0 ] && [ "$min" -gt 0 ]; then
      printf '  DRIFT  %-24s 0 matches, expected >= %s. Upstream reworded it.\n' "$id" "$min"
      fail=1
    else
      printf '  ok     %-24s %s match(es)\n' "$id" "$n"
    fi
  done < "$RULES_FILE"
  return $fail
}

if [ "$MODE" = "--check" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"; rm -f "$RULES_FILE"' EXIT
  echo "Checking generated output against committed skills/"
  run_translation "$TMP/skills"
  report_rules || true
  echo
  if diff -rq "$OUT" "$TMP/skills" >/dev/null 2>&1; then
    echo "skills/ is up to date with upstream + rules"
  else
    echo "skills/ differs from a fresh translation. Re-run ./scripts/sync.sh"
    diff -rq "$OUT" "$TMP/skills" || true
  fi
  echo
  echo "Upstream pin:"
  git -C "$VENDOR" log --oneline -1
else
  echo "Regenerating skills/ from vendor/matt-pocock"
  run_translation "$OUT"
  report_rules || true
  echo
  echo "Upstream pin:"
  git -C "$VENDOR" log --oneline -1
  if [ "${MISSING:-0}" -ne 0 ]; then
    echo "An allowlisted skill is missing upstream. Fix the allowlist." >&2
    exit 1
  fi
fi
