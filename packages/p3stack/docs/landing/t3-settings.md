# Configure T3 on each machine

T3 starts Pi with `providerInstances.pi.config.launchArgs`. That value loads claude-subscription before T3 appends its bridge extension, so claude-subscription sets the system prompt first. The path must be the same file that the Pi package loads. Pi then loads the file once, in the launch-argument position. A different copy of the file loads twice, and its duplicate tools stop Pi from starting.

Each machine loads the root package from a different place, so each has its own value.

| Machine | Package source in `~/.pi/agent/settings.json` | `launchArgs` |
| --- | --- | --- |
| Omarchy | `../../Code/pi-packages`, through the linked `global/settings.json` | `--extension /home/danballance/Code/pi-packages/packages/claude-subscription/extensions/claude-subscription/index.ts` |
| Mac | `git:github.com/daniel-ballance/pi-packages` | `--extension /Users/danballance/.pi/agent/git/github.com/daniel-ballance/pi-packages/packages/claude-subscription/extensions/claude-subscription/index.ts` |

Print the value from the install that the machine loads, rather than typing it.

```sh
node ~/Code/pi-packages/scripts/root-package.mjs --t3-launch-args
node ~/.pi/agent/git/github.com/daniel-ballance/pi-packages/scripts/root-package.mjs --t3-launch-args
```

Run the first command on Omarchy and the second on the Mac.

## Update Omarchy after landing

The settings file is `/home/danballance/.t3/userdata/settings.json`. The provider binary path does not change.

Before:

```json
"launchArgs": "--extension /home/danballance/Code/pi-packages/packages/p3stack/claude-subscription/extensions/claude-subscription/index.ts"
```

After:

```json
"launchArgs": "--extension /home/danballance/Code/pi-packages/packages/claude-subscription/extensions/claude-subscription/index.ts"
```

1. Update the stable checkout at `~/Code/pi-packages` to the landed change. The old path no longer exists after this step, so finish the next steps before you open a T3 thread.
2. Complete the frozen dependency install and the root check.
3. Run `bash global/link.sh --check` from the stable checkout. Every line must begin with `ok`.
4. Copy the T3 settings file to a dated backup beside it.
5. Replace the `launchArgs` value with the output of `--t3-launch-args`.
6. Verify the new thread, as described in [Verify each machine](#verify-each-machine).

## Move the Mac to the GitHub install

The settings file is `/Users/danballance/.t3/userdata/settings.json`. The provider binary stays `/opt/homebrew/bin/pi`.

Before:

```json
"launchArgs": "--extension /Users/danballance/Code/pi-packages/packages/p3stack/claude-subscription/extensions/claude-subscription/index.ts"
```

After:

```json
"launchArgs": "--extension /Users/danballance/.pi/agent/git/github.com/daniel-ballance/pi-packages/packages/claude-subscription/extensions/claude-subscription/index.ts"
```

Change the package source and the launch argument together. Between the two changes, a new thread loads two copies of claude-subscription.

1. Follow [Set up the Mac](../../../../global/README.md#set-up-the-mac). It installs the GitHub source and removes the local checkout entry from `~/.pi/agent/settings.json`.
2. Copy the T3 settings file to a dated backup beside it.
3. Replace the `launchArgs` value with the output of `--t3-launch-args`.
4. Verify the new thread, as described in [Verify each machine](#verify-each-machine).

`pi update` resets the clone in place, so the path stays valid. `pi remove` deletes the clone. After a removal, T3 cannot start Pi until you install the source again or change `launchArgs`.

## Verify each machine

T3 reads `launchArgs` when it starts a thread's Pi process. A running Pi process keeps its old arguments.

1. Open a fresh T3 thread.
2. Run `/p3stack doctor`. It writes `~/.pi/agent/p3stack/t3-contract.json`.
3. Check that the report has `claudeSubscriptionBeforeBridge: true`, one entry in `claudeSubscriptionFiles`, and no `problems`. The entry must equal the path in `launchArgs`.
4. Run the operator's T3 smoke and record it as a new dated file in this directory. The [2026-10-20 record](2026-10-20-t3-smoke.md) shows the format.

## Undo if the smoke fails

Copy the dated backup over the T3 settings file. On the Mac, also restore the previous package entry in `~/.pi/agent/settings.json`. Check that the restored `launchArgs` path exists, then open a fresh thread.
