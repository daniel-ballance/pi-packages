# Update T3 after landing

The PR does not edit live T3 settings, restart a provider, or relink the live home. Run these steps only after the stack lands. The new extension path must exist in each stable checkout first.

## Review the exact changes

Linux file is `/home/danballance/.t3/userdata/settings.json`. The existing provider binary path is unchanged.

Before:

```json
"launchArgs": "--extension /home/danballance/Code/pi-packages/packages/claude-subscription/extensions/claude-subscription/index.ts"
```

After:

```json
"launchArgs": "--extension /home/danballance/Code/pi-packages/packages/p3stack/claude-subscription/extensions/claude-subscription/index.ts"
```

Mac file is `/Users/danballance/.t3/userdata/settings.json`. Its provider binary remains `/opt/homebrew/bin/pi`. The read-only SSH snapshot had no extension argument, so the after line adds one rather than rewrites an existing path.

Before:

```json
"launchArgs": ""
```

After:

```json
"launchArgs": "--extension /Users/danballance/Code/pi-packages/packages/p3stack/claude-subscription/extensions/claude-subscription/index.ts"
```

Both lines are `providerInstances.pi.config.launchArgs`. Do not change another provider or point T3 at a swarm worktree.

## Apply on each machine

1. Update the stable checkout at `~/Code/pi-packages` to the landed stack.
2. Complete its frozen dependency install and root check.
3. Retrieve the reviewed scripts from the PR's secret receipt gist into `/tmp/pr-12-proof/landing/` on the corresponding machine.
4. Run `bash /tmp/pr-12-proof/landing/apply-linux.sh` on Linux or `bash /tmp/pr-12-proof/landing/apply-mac.sh` on the Mac.
5. Save the dated backup path printed by the script.
6. Restart the T3 Pi provider manually and open a fresh T3 thread.
7. Run the operator's T3 smoke and record the result before scheduling maintenance.

The scripts require the observed before value and an existing new extension file. They save `settings.json.pr-12.<UTC date>.bak` next to the settings file before replacing it atomically. They do not restart T3. A changed before value stops the script for review.

## Undo immediately if the smoke fails

Run the matching script with the exact dated backup path.

```sh
bash /tmp/pr-12-proof/landing/undo-linux.sh /home/danballance/.t3/userdata/settings.json.pr-12.<UTC-date>.bak
bash /tmp/pr-12-proof/landing/undo-mac.sh /Users/danballance/.t3/userdata/settings.json.pr-12.<UTC-date>.bak
```

Run only the command for that machine. Undo restores the entire dated settings snapshot, so inspect any newer settings changes before rollback. The script refuses a different live extension argument or a backup outside the settings directory. Restart the provider manually after rollback.

## Keep home links on the stable checkout

Existing correct links need no relink. Run `bash global/link.sh --check` from the stable checkout after landing. Every line must begin with `ok`. If repair is needed, run the linker there, never from a swarm worktree. Keep any backup it creates until the operator verifies a fresh Pi session.

The screenshot, terminal video, `/reload`, and fresh T3 thread are operator steps. Text captures in the PR receipts do not replace that review.
