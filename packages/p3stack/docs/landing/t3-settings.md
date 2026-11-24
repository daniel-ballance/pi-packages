# Configure T3 on each machine

T3 Code can discover claude-subscription through the installed root package. You do not need a provider launch argument to use Pi's native prompt. A standalone p3stack install needs no subscription provider.

If you keep an explicit provider in `providerInstances.pi.config.launchArgs`, it must name the **same file** the package loads. Loading a second copy registers duplicate tools and can stop Pi from starting. Back up your T3 settings before changing them.

Run this from the root of the copy Pi actually loads, not from a development worktree:

```sh
node scripts/root-package.mjs --t3-launch-args
```

Use the printed argument. For the Git install, the default clone is under `~/.pi/agent/git/github.com/daniel-ballance/pi-packages`. Run `pi update git:github.com/daniel-ballance/pi-packages` to update it in place. If you remove or move the clone, remove the argument or point it at the new install. See [the owner's machine setup](../../../../global/README.md) for checkout and Git installs.

## Verify each machine

1. Open a fresh T3 thread. A running Pi process keeps its old arguments.
2. Run `/p3stack doctor`. This T3-only command writes `p3stack/t3-contract.json` under `PI_CODING_AGENT_DIR`, which defaults to `~/.pi/agent`.
3. For the owner's subscription install, expect one entry in `claudeSubscriptionFiles` and no `problems`. If you kept a launch argument, the entry must match that file. The order relative to the bridge does not matter for the native prompt. The exactly-one-provider check is not a prerequisite for standalone p3stack.
4. Test the capability you changed in the new thread. Doctor records the tool inventory, not whether delegation, cancellation, or a workflow succeeds. Record the command, result, and any check you could not run. If the change prevents startup, restore the settings backup and check that any explicit provider path still exists.

The [October 20](2026-10-20-t3-smoke.md) and [October 21](2026-10-21-t3-smoke.md) records show delegation on the installations tested then. Their paths, models, and T3 versions are not current setup instructions.
