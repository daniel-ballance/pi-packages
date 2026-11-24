# Check the loader and start a fresh process

Run both commands from the **repository root of the worktree under test**. Set `guard=packages/p3stack/skills/maintain-p3stack/scripts/with-smoke-dir.sh`. The guard gives each command a new private settings directory outside the checkout. It copies only auth.json when needed from the selected agent directory and removes the fixture on exit. Use existing credentials; if unavailable, report blocked rather than installing or signing in.

1. `bash "$guard" pi list` must list this worktree's local p3stack package.
2. `bash "$guard" pi --mode json --no-session --model "<session-provider/model:thinking>" -p "Reply exactly p3stack smoke ok. Do not call tools."` must exit 0. Pass the session's selected identity explicitly. Inspect JSONL for a final reply and loader failures, missing resources or skill collisions. Wording variance alone is not a loader failure.

Save only nonsecret output outside the checkout, never the fixture. Recheck repository status. A scheduled run uses the identity selected for its bound thread.
