### 1. Pin the fixed point and capture the review input

Reuse the caller's pinned base and captured input. If no base is pinned, use `git merge-base <fixed-point> HEAD` with the supplied ref; ask for a ref only if it is missing. Record base and head SHAs. Run capture commands from the repository root (`git rev-parse --show-toplevel`). For input not yet captured, pass the caller's paths relative to that root as separate arguments after `--` (`:/` for a whole-branch review). Set `GIT_OPTIONAL_LOCKS=0` for Git queries.

- **Committed range requested, or scoped status clean** (`git status --porcelain=v1 --untracked-files=all -- <paths>`): use `git diff <base> HEAD -- <paths>`.
- **Work in progress:** label `git diff --cached <base> -- <paths>` and `git diff -- <paths>` separately. Enumerate untracked paths with `git ls-files --others --exclude-standard -z -- <paths>`. An untracked file counts even if both patches are empty.

Manifest each changed version by path, byte size and content hash. Mark deletions and binary files; hash symlink targets without following them. Keep the checkout and index read-only. Stop on an unresolved base or empty scope; report any input you could not hand over or whose hash changed before review.
