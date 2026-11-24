# Configure T3 on each machine

T3 Code can discover claude-subscription through the installed root package. You do not need a provider launch argument to use Pi's native prompt. A standalone p3stack install needs no subscription provider.

If you keep an explicit provider in `providerInstances.pi.config.launchArgs`, it must name the **same file** the package loads. Loading a second copy registers duplicate tools and can stop Pi from starting. Back up your T3 settings before changing them.

Run this from the root of the copy Pi actually loads, not from a development worktree:

```sh
node scripts/root-package.mjs --t3-launch-args
```

Use the printed argument. For the Git install, the default clone is under `~/.pi/agent/git/github.com/daniel-ballance/pi-packages`. Run `pi update git:github.com/daniel-ballance/pi-packages` to update it in place. If you remove or move the clone, remove the argument or point it at the new install. See [the owner's machine setup](../../../../global/README.md) for checkout and Git installs.

## Verify host compatibility

Follow the [maintenance host check](../../authored/skills/maintain-p3stack/references/verify-host.md) on each machine. In the doctor dump, `claudeSubscriptionFiles` should contain one real path for the subscription or none without it. More than one distinct file is a problem. Doctor reports file identity, not load order. If the change prevents startup, restore the settings backup and check that any explicit provider path still exists.

The [October 20](2026-10-20-t3-smoke.md) and [October 21](2026-10-21-t3-smoke.md) records show delegation on the installations tested then. Their paths, models, and T3 versions are not current setup instructions. The [historical version and bridge checksum](https://github.com/daniel-ballance/pi-packages/blob/b6abc7bf646ffc5a1abbcc896386779f2447dc37/packages/p3stack/rules/t3-pin.json) are support data, not a compatibility gate.
