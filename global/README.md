# Pi configuration

This directory owns the nonsecret global configuration of the Omarchy machine. There, the four files in `~/.pi/agent/` link to the stable checkout at `~/Code/pi-packages/global/`, not to a worktree. The Mac does not link them. See [Set up the Mac](#set-up-the-mac).

Pi and Omarchy can write those files while running. Read the main checkout's `git diff global/` before changing repository copies. Commit intended changes through a worktree and preserve unrelated live edits.

## Ownership and scope

| File | Purpose |
| --- | --- |
| `settings.json` | Global preferences and the root package declaration |
| `models.json` | Model metadata overrides and the Halogen LAN provider |
| `mcp.json` | Native Pi MCP server configuration |
| `subagents.json` | Global child allowlist and the Claude provider mapping |

The package entry is `../../Code/pi-packages`, the checkout root. Relative package paths resolve from the Pi agent directory, not from the symlink target. The root package includes self-reload, so this repository's project settings do not add a second copy.

mcp-client is not loaded. Native Pi reads `mcpServers`, seconds-based `timeout`, and `toolExposure` from `mcp.json`. Do not enable the optional replacement without reviewing its timeout and configuration migration rules. Playwright remains pinned to 0.0.82. The package move does not update a server or change the MCP file.

Child policies replace the whole file rather than merge. Lookup uses the parent's launch directory and does not search ancestors. `workingDirectories` and tool allowlists reduce capabilities but do not provide an OS sandbox. The repository policy names the Claude provider as `loaded:claude-subscription`. That reference resolves to the file the parent loaded, so the policy holds no machine path.

Parent and child model choices are independent. A local parent does not imply local-only work. Hosted models, MCP servers, and web search can contact external services. Do not put credentials in these files.

## Verify links without changing the live home

```sh
bash global/link.sh --check
python3 -B -m unittest discover -s global/tests
```

`--check` compares symlink identity and validates source JSON without writing. From a development worktree, invoke the stable checkout's `global/link.sh --check` to check live links. A worktree's copy expects worktree targets and correctly reports drift against stable-checkout links.

The package move does not require relinking existing correct symlinks. After it lands in the stable checkout, those links read the new repository settings. Do not relink them to an unlanded worktree. Follow [Configure T3 on each machine](../packages/p3stack/docs/landing/t3-settings.md) before restarting its provider.

## Link or repair after landing

```sh
bash global/link.sh
bash global/link.sh --check
```

The linker needs Bash, coreutils-compatible `readlink -f`, and `jq`. It supports GNU and BSD `mv`. `PI_CODING_AGENT_DIR` selects a custom agent directory. `PI_AGENT_DIR` is a legacy fallback. Custom directories need package paths that resolve from their own location and separate authentication.

The linker validates every source and target before it writes. It refuses directory targets and preserves replaced files or links under dated `pi-config-backup.*` directories. It does not import detached settings. Review backups before removing them.

Run `/reload` in existing Pi sessions after configuration changes. Finish or close children first. Sessions do not refresh each other.

## Omarchy themes

`~/.pi/agent/themes/omarchy-system.json` is generated and untracked. The explicit `omarchy-theme-set-pi --activate` command replaces the settings symlink with a file. The theme-set hook repairs links after ordinary hooks run, but a direct activate call needs an explicit repair.

The hook belongs at `~/.config/omarchy/hooks/theme-set.d/theme-set-relink-pi-config`, linked to `global/hooks/theme-set-relink-pi-config` in the stable checkout. It targets the normal home agent directory even when the caller uses a custom Pi fixture.

## Set up the Mac

The Mac installs the root package from GitHub and keeps its own `~/.pi/agent/settings.json`. It does not run `link.sh`, because linking would replace that file with the Omarchy settings.

1. Check that `~/.pi/agent/settings.json` is a plain file, not a link into a checkout. Remove old copies of this repository's extensions from `~/.pi/agent/extensions/`, because Pi loads that directory too and two copies of one tool stop Pi from starting.
2. Run `pi install git:github.com/daniel-ballance/pi-packages`. Pi clones the repository into `~/.pi/agent/git/github.com/daniel-ballance/pi-packages` and adds the source to `settings.json`.
3. Remove any other package entries that load this repository, such as a local checkout path.
4. Leave `~/.pi/agent/subagents.json` absent. The built-in policy offers Claude children when the parent loaded claude-subscription from one file.
5. Set the T3 launch argument from [Configure T3 on each machine](../packages/p3stack/docs/landing/t3-settings.md).
6. Authenticate providers through Pi and verify `pi list` and `/mcp` in a fresh session.

Run `pi update` to update the clone.

## Restore a linked machine

1. Clone the repository with submodules to `~/Code/pi-packages`.
2. Follow the root README's frozen install and root check.
3. Review machine-specific package paths, models, and policy.
4. Link the four files from that stable checkout.
5. Authenticate providers through Pi and verify `pi list` and `/mcp` in a fresh session.

Keep `auth.json`, MCP credentials, sessions, model stores, and child runtime state out of Git. Backups can contain private configuration. Review them before manual cleanup. No automatic retention job deletes them.
