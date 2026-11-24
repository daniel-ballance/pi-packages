### 1. Pin the fixed point and capture the review input

Use the commit, branch, or tag the user supplied. If they didn't specify a fixed point, ask for it. From the repository root, run `git merge-base <fixed-point> HEAD`. Stop if it fails. Record the returned SHA as `<base>` and the commit list from `git log <base>..HEAD --oneline`.

Run `git status --porcelain=v1 --untracked-files=all`. Capture the review input once, without changing any files or staging anything:

- **Status has entries — review the working tree.** Capture `git diff --cached <base> --` (branch commits plus staged changes) and `git diff --` (unstaged changes). Keep the two patches labeled. List untracked files with `git ls-files --others --exclude-standard -z`; include each NUL-delimited path and its contents as a new file. For a symlink, record its target without following it.
- **Status is empty — review the committed range.** Capture `git diff <base> HEAD --`.

Stop here on a failed command or if there is nothing to review. An untracked file counts even when both tracked patches are empty.
