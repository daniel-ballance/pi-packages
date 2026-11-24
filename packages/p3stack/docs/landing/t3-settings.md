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
3. Check `problems` and `claudeSubscriptionFiles`. Zero files is valid; if you use the subscription, expect one real path. More than one distinct file is a problem. Any explicit launch argument must resolve to the same file the package loads. Doctor reports file identity, not load order.
4. Test the capability you changed in the new thread. Doctor records the tool inventory, not whether delegation, cancellation, or a workflow succeeds. Record the command, result, and any check you could not run. If the change prevents startup, restore the settings backup and check that any explicit provider path still exists.

## Verify host compatibility

From the pi-packages root:

1. Run `node packages/p3stack/generator/check-t3-pin.mjs`. This checks the repository's [T3 host map](../../extra/skills/poteto-mode/references/host-t3.md) and `rules/t3-pin.json` without reading an installed host. The recorded release and bridge hash are provenance, not acceptance criteria.
2. For installed-state diagnostics only, add `--installed`. Use `--state <file>` or `--bridge <file>` with that flag to select diagnostic inputs. A new version or hash alone is not a failure.
3. For live verification, launch a fresh T3 Code thread with `PI_CODING_AGENT_DIR` set to a disposable directory outside the checkout and your normal agent directory. Confirm the dump destination before running `/p3stack doctor`. Run `node packages/p3stack/generator/check-t3-pin.mjs --doctor <dump>` against that report. Require no reported problems, all required tools and the required direct exposures. Extra tools and missing optional PR watches do not fail the check.
4. Compare the live descriptions and observed behavior for the changed operations with the map and the bridge prompt return contract in `rules/t3-pin.json`. A passing inventory does not prove arguments, return shapes or behavior. Record what was verified and what was unavailable. If required behavior is missing, stop maintenance and repair the host contract separately from vendor bumps; do not change the installed host or refresh fingerprints to pass.

The [October 20](2026-10-20-t3-smoke.md) and [October 21](2026-10-21-t3-smoke.md) records show delegation on the installations tested then. Their paths, models, and T3 versions are not current setup instructions.
