# Land a verified maintenance PR

Run these commands from the **repository root** of the candidate worktree. Scope forge calls to the owner/name resolved from origin. If asked to pause, return the ready PR URL without merging.

1. Fetch origin. If `git merge-base --is-ancestor origin/main HEAD` fails, rebase onto the new main, rerun all pre-merge gates on the rebased head and push your own branch with hooks and `--force-with-lease`. On conflict abort; do not land the stale candidate.
2. Require the PR in this repository to be open, ready, based on main, and at your verified `git rev-parse HEAD`. Run `gh pr merge <number> --repo <repo> --admin --squash --match-head-commit <head>`. Confirm MERGED and read the exact merge commit. Delete only your own landed remote branch.
3. Fetch origin. In a fresh detached worktree at that merge commit, run `git submodule update --init --recursive`, `./scripts/ci-install.sh` and `./scripts/check.sh`; require exit 0 and final line `Root check passed.` Run the [loader and smoke](references/smoke.md) from that worktree's root.
4. **Green:** record the merge commit and PR. Remove only your verification worktree. Recheck each proposed superseded PR's repository, base, unchanged head and paths/note: every change must be superseded by this landing. Close only confirmed matches, with a link to the replacement. Leave uncertain or changed PRs open.
5. **Red:** retain the verification worktree and nonsecret evidence; leave superseded PRs open. For a failed source bump, follow the [revert guard](references/revert.md) once. For a failed revert or a PR without source-bump provenance, report blocked; no recursive revert.
