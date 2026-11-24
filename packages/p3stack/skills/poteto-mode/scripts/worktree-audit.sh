#!/usr/bin/env bash
# Worktree prune audit. Fetches the base when it is an origin ref. Classifies
# every git worktree by size, merge state, uncommitted work, remote/PR state,
# and the most recent chat that operated in it. Emits a table sorted by size.
# Never deletes a worktree; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [-b|--base <ref>] [--session-dir <dir>] [repo-path]
#   repo-path defaults to the current repo.
#   -b sets the ref the MERGED column checks against (e.g. origin/integration).
#   Without it the base is origin/HEAD, then origin/main, then origin/master.
#   origin/HEAD is the remote's default branch, not necessarily the branch PRs
#   merge into; pass -b when they differ.
set -u

# A caller (including a Git hook) may have selected a different repo or index.
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_IMPLICIT_WORK_TREE GIT_GRAFT_FILE GIT_SHALLOW_FILE \
  GIT_NO_REPLACE_OBJECTS GIT_REPLACE_REF_BASE GIT_PREFIX GIT_CEILING_DIRECTORIES \
  GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS

base=""
session_args=()
while [ $# -gt 0 ]; do
	case "$1" in
	-b|--base) [ $# -ge 2 ] || { echo "error: $1 needs a ref" >&2; exit 2; }; base="$2"; shift 2 ;;
	--session-dir) [ -n "${2:-}" ] || { echo "error: $1 needs a directory" >&2; exit 2; }
		case "$2" in /*|\~*) session_args=(--session-dir "$2") ;; *) session_args=(--session-dir "$PWD/$2") ;; esac; shift 2 ;;
	-h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
	-*) echo "error: unknown option: $1" >&2; exit 2 ;;
	*) break ;;
	esac
done

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$repo" || exit 1
git rev-parse --git-dir >/dev/null 2>&1 || { echo "error: not a git repo: $repo" >&2; exit 1; }

# Keep Git's NUL-delimited paths intact; never audit a partial listing.
tmp=$(mktemp -d) || exit 1
trap 'rm -f "$tmp/worktrees" "$tmp/prs"; rmdir "$tmp"' EXIT
git worktree list --porcelain -z > "$tmp/worktrees" || exit 1
main_wt=""

if [ -z "$base" ]; then
	for cand in "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
		[ -n "$cand" ] && git rev-parse --verify --quiet "$cand^{commit}" >/dev/null && { base="$cand"; break; }
	done
	[ -z "$base" ] && { echo "error: no base ref (origin/HEAD, origin/main, origin/master all missing); pass -b <ref>" >&2; exit 1; }
	echo "warn: no -b given; MERGED checks against $base" >&2
fi

# Fetch before resolving a remote base; a stale ref cannot clear a worktree.
base_current=yes
case "$base" in
origin/*) git fetch origin "+refs/heads/${base#origin/}:refs/remotes/$base" --quiet 2>/dev/null \
	|| { base_current=no; echo "warn: could not fetch $base" >&2; } ;;
esac
git rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1 || { echo "error: base ref not found: $base" >&2; exit 1; }

# GNU and BSD date use different flags for epoch seconds.
if date -d @0 >/dev/null 2>&1; then
	fmt_day() { date -d "@$1" '+%Y-%m-%d'; }
else
	fmt_day() { date -r "$1" '+%Y-%m-%d'; }
fi

# PR state by branch, fetched once as [{number, state, head}] with a lowercase
# state. Origin when its CLI can read this repo's PRs, otherwise gh. Empty when
# neither can.
prs="$tmp/prs"
if command -v origin >/dev/null 2>&1 \
	&& raw=$(origin pr list --author "@me" --state all --limit 1000 \
		--json number,status,headRef 2>/dev/null); then
	printf '%s' "$raw" | jq '[.[] | {number, state: .status, head: .headRef}]' > "$prs" 2>/dev/null
elif raw=$(gh pr list --author "@me" --state all --limit 1000 \
	--json number,state,headRefName 2>/dev/null); then
	printf '%s' "$raw" | jq '[.[] | {number, state: (.state | ascii_downcase), head: .headRefName}]' > "$prs" 2>/dev/null
fi

now=$(date +%s)

echo "# base: $base"
printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE\n"

while IFS= read -r -d '' field; do
	case "$field" in 'worktree '*) wt=${field#worktree } ;; *) continue ;; esac
	if [ -z "$main_wt" ]; then main_wt=$wt; continue; fi

	size=$(du -sh "$wt" 2>/dev/null) && size=${size%%[[:space:]]*} || size="?"
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")

	merged="?"
	if [ "$base_current" = yes ] && [ -n "$head" ]; then
		git merge-base --is-ancestor "$head" "$base" 2>/dev/null
		case $? in 0) merged=YES ;; 1) merged=no ;; esac
	fi

	# Porcelain v1 quotes embedded newlines. Count records, never split a path.
	dirty=unknown; ignored_dirs="?"
	if top=$(git -C "$wt" rev-parse --show-toplevel) && [ "$top" -ef "$wt" ] \
		&& flags=$(git -C "$wt" ls-files -v) \
		&& porcelain=$(git -C "$wt" status --porcelain=v1 --untracked-files=all --ignored=matching --ignore-submodules=none); then
		wip=0; untracked=0; ignored_files=0; ignored_dirs=0
		while IFS= read -r entry; do
			case "$entry" in [a-zS]' '*) ((wip++)) ;; esac
		done <<< "$flags"
		while IFS= read -r entry; do
			case "$entry" in
			'') ;;
			'?? '*) ((untracked++)) ;;
			'!! '*/|'!! '*'/"') ((ignored_dirs++)) ;; # Git may quote the directory name.
			'!! '*) ((ignored_files++)) ;;
			*) ((wip++)) ;;
			esac
		done <<< "$porcelain"
		dirty=""
		[ "$wip" -eq 0 ] || dirty="wip:$wip"
		[ "$untracked" -eq 0 ] || dirty="untracked:$untracked${dirty:+,$dirty}"
		[ "$ignored_files" -eq 0 ] || dirty="ignored-files:$ignored_files${dirty:+,$dirty}"
		dirty=${dirty:-clean}
	fi

	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null)
	case $? in
	1) remote=detached ;;
	0) if tip=$(git -C "$wt" rev-parse --verify --quiet "refs/remotes/origin/$branch"); then
		if [ "$tip" = "$head" ]; then remote=pushed
		elif count=$(git -C "$wt" rev-list --count "$tip..$head"); then remote="ahead$count"
		else remote="?"; fi
	else [ $? -eq 1 ] && remote=no-remote || remote="?"; fi ;;
	*) remote="?" ;;
	esac

	pr="-"
	if [ -n "$branch" ]; then
		if [ -s "$prs" ] && matches=$(jq -r --arg b "$branch" \
			'.[] | select(.head==$b) | "#\(.number)/\(.state)"' "$prs"); then
			[ -z "$matches" ] || pr=${matches%%$'\n'*}
		else pr="?"; fi
	fi

	last="-"; recent=no
	if last_ts=$(node "$script_dir/worktree-session-activity.mjs" "$main_wt" "$wt" ${session_args[@]+"${session_args[@]}"}); then
		if [ "$last_ts" -gt 0 ]; then
			last=$(fmt_day "$last_ts") || last="?"
			[ $(( (now - last_ts) / 86400 )) -gt 4 ] || recent=yes
		fi
	else last="?"; fi

	case "$dirty" in
	unknown) bucket=unknown ;;
	ignored-files:*) bucket=hold-ignored ;;
	untracked:*) bucket=hold-untracked ;;
	wip:*) bucket=hold-wip ;;
	*)  case "$pr" in */open|*/draft) bucket=hold-open-pr ;; *)
		if [ "$recent" = yes ]; then bucket=verify-recent-chat
		elif [[ "$size $age $merged $remote $pr $last" == *'?'* ]]; then bucket=unknown
		elif [ "$merged" = YES ]; then bucket=safe
		else bucket=review; fi ;;
	    esac ;;
	esac

	[ "$last" != "?" ] || bucket=unknown

	# Preserve a single display row even for names containing control characters.
	[[ "$wt" != *[[:cntrl:]]* ]] || printf -v wt '%q' "$wt"
	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty,ignored-dirs:$ignored_dirs" "$remote" "$pr" "$last" "$bucket" "$wt"
done < "$tmp/worktrees" | sort -t$'\t' -k1,1 -rh
