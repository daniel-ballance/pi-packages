#!/usr/bin/env bash
# Worktree prune audit. Fetches the base when it is an origin ref. Classifies
# every git worktree by size, merge state, uncommitted work, remote/PR state,
# and the most recent chat that operated in it. Emits a table sorted by size.
# Never deletes a worktree; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [-b|--base <ref>] [repo-path]
#   repo-path defaults to the current repo.
#   -b sets the ref the MERGED column checks against (e.g. origin/integration).
#   Without it the base is origin/HEAD, then origin/main, then origin/master.
#   origin/HEAD is the remote's default branch, not necessarily the branch PRs
#   merge into; pass -b when they differ.
set -u

base=""
while [ $# -gt 0 ]; do
	case "$1" in
	-b|--base) [ $# -ge 2 ] || { echo "error: $1 needs a ref" >&2; exit 2; }; base="$2"; shift 2 ;;
	-h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
	-*) echo "error: unknown option: $1" >&2; exit 2 ;;
	*) break ;;
	esac
done

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
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

# GNU coreutils (Linux, Homebrew gnubin) reads `stat -f` as file system status
# and `date -r` as a file, so pick the stat and date flags once.
if stat -c %Y / >/dev/null 2>&1; then
	stat_fmt=(-c '%Y'); fmt_day() { date -d "@$1" '+%Y-%m-%d'; }
else
	stat_fmt=(-f '%m'); fmt_day() { date -r "$1" '+%Y-%m-%d'; }
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

# A nested cwd has its own session directory. Check headers before reading
# turns: the flat custom directory and encoded prefixes need not be unique.
session_activity() {
	local root dir file cwd encoded main_encoded header quoted ts latest=0
	encoded=$(printf '%s' "${wt#/}" | sed 's#[/\\:]#-#g')
	main_encoded=$(printf '%s' "${main_wt#/}" | sed 's#[/\\:]#-#g')
	root=${PI_CODING_AGENT_SESSION_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions}
	[ ! -d "$root" ] || { [ -r "$root" ] && [ -x "$root" ]; } || return 1
	for dir in "${PI_CODING_AGENT_SESSION_DIR:-/dev/null}" "$root/--$main_encoded--" \
		"$root/--$encoded--" "$root/--$encoded-"*--; do
		[ -d "$dir" ] || continue
		[ -r "$dir" ] && [ -x "$dir" ] || return 1
		for file in "$dir"/*.jsonl; do
			[ -f "$file" ] || continue
			header=$(head -n 1 "$file") && cwd=$(jq -er 'select(.type == "session") | .cwd' <<< "$header") || return 1
			case "$cwd" in
			"$wt"|"$wt"/*) ;; # A session started here.
			"$main_wt"|"$main_wt"/*)
				quoted=$(jq -Rn --arg path "$wt" '$path') || return 1
				quoted=${quoted#\"}
				grep -qF -e "${quoted%\"}/" -e "$quoted" "$file" || { [ $? -eq 1 ] && continue; return 1; } ;;
			*) continue ;;
			esac
			ts=$(stat "${stat_fmt[@]}" "$file") || return 1
			[ "$ts" -le "$latest" ] || latest=$ts
		done
	done
	printf '%s\n' "$latest"
}
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
	dirty=unknown
	if porcelain=$(git -C "$wt" status --porcelain=v1 --untracked-files=all --ignored --ignore-submodules=none); then
		wip=0; untracked=0
		while IFS= read -r entry; do
			case "$entry" in '') ;; '?? '*|'!! '*) ((untracked++)) ;; *) ((wip++)) ;; esac
		done <<< "$porcelain"
		dirty=clean
		if [ "$untracked" -gt 0 ]; then
			dirty="untracked:$untracked"
			[ "$wip" -eq 0 ] || dirty="$dirty,wip:$wip"
		elif [ "$wip" -gt 0 ]; then dirty="wip:$wip"; fi
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
	if last_ts=$(session_activity); then
		if [ "$last_ts" -gt 0 ]; then
			last=$(fmt_day "$last_ts") || last="?"
			[ $(( (now - last_ts) / 86400 )) -gt 4 ] || recent=yes
		fi
	else last="?"; fi

	case "$dirty" in
	unknown) bucket=unknown ;;
	untracked:*) bucket=hold-untracked ;;
	wip:*) bucket=hold-wip ;;
	*)  case "$pr" in */open|*/draft) bucket=hold-open-pr ;; *)
		if [ "$recent" = yes ]; then bucket=verify-recent-chat
		elif [[ "$size $age $merged $remote $pr $last" == *'?'* ]]; then bucket=unknown
		elif [ "$merged" = YES ]; then bucket=safe
		else bucket=review; fi ;;
	    esac ;;
	esac

	# Preserve a single display row even for names containing control characters.
	[[ "$wt" != *[[:cntrl:]]* ]] || printf -v wt '%q' "$wt"
	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done < "$tmp/worktrees" | sort -t$'\t' -k1,1 -rh
