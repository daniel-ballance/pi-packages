# Pi configuration

This directory owns the nonsecret global configuration. The four files in `~/.pi/agent/` link to the stable checkout at `~/Code/pi-packages/global/`, not to a worktree.

Pi and Omarchy can write those files while running. Read the main checkout's `git diff global/` before changing repository copies. Commit intended changes through a worktree and preserve unrelated live edits.

## Ownership and scope

| File | Purpose |
| --- | --- |
| `settings.json` | Global preferences and the single p3stack package declaration |
| `models.json` | Model metadata overrides and the Halogen LAN provider |
| `mcp.json` | Native Pi MCP server configuration |
| `subagents.json` | Global child allowlist and provider extension paths |

The package entry is `../../Code/pi-packages/packages/p3stack`. Relative package paths resolve from the Pi agent directory, not from the symlink target. The package includes self-reload, so this repository's project settings do not add a second component identity.

mcp-client is not loaded. Native Pi reads `mcpServers`, seconds-based `timeout`, and `toolExposure` from `mcp.json`. Do not enable the optional replacement without reviewing its timeout and configuration migration rules. Playwright remains pinned to 0.0.82. The package move does not update a server or change the MCP file.

Child policies replace the whole file rather than merge. Lookup uses the parent's launch directory and does not search ancestors. `workingDirectories` and tool allowlists reduce capabilities but do not provide an OS sandbox. The repository policy points the Claude provider at `packages/p3stack/claude-subscription/extensions/claude-subscription/index.ts`.

Parent and child model choices are independent. A local parent does not imply local-only work. Hosted models, MCP servers, and web search can contact external services. Do not put credentials in these files.

## Verify links without changing the live home

```sh
bash global/link.sh --check
python3 -B -m unittest discover -s global/tests
```

`--check` compares symlink identity and validates source JSON without writing. From a development worktree, invoke the stable checkout's `global/link.sh --check` to check live links. A worktree's copy expects worktree targets and correctly reports drift against stable-checkout links.

The consolidation does not require relinking existing correct symlinks. After the stack lands in the stable checkout, those links read the new repository settings. Do not relink them to an unlanded worktree. Follow the [T3 landing instructions](../packages/p3stack/docs/landing/t3-settings.md) before restarting its provider.

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

## Restore on another machine

1. Clone the repository with submodules to `~/Code/pi-packages`.
2. Follow the root README's frozen install and root check.
3. Review machine-specific package paths, models, and policy.
4. Link the four files from that stable checkout.
5. Authenticate providers through Pi and verify `pi list` and `/mcp` in a fresh session.

Keep `auth.json`, MCP credentials, sessions, model stores, and child runtime state out of Git. Backups can contain private configuration. Review them before manual cleanup. No automatic retention job deletes them.
