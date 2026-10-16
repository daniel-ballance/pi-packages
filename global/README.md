# Pi configuration

This directory owns the nonsecret global configuration. `~/.pi/agent/` contains
links to these files in the main checkout at `~/Code/pi-packages/global/`. The
packages these settings load live next door in `packages/`.

Pi and Omarchy write to these files while they run, so the main checkout picks up
uncommitted changes here. Commit them through a worktree branch like any other
change: copy the live file into the worktree, commit, and merge.

## Ownership and scope

| File | Purpose |
| --- | --- |
| `settings.json` | Global preferences, parent model cycle, and local package declarations |
| `models.json` | Deliberate model metadata overrides and the Halogen LAN provider |
| `mcp.json` | Context7 and version-pinned, headless Playwright using system Chromium |
| `subagents.json` | Conservative global child policy: read/search tools, no shell/edit/write or peers |

The package paths in global settings resolve from the **Pi agent directory**,
not this symlink target. Project package paths resolve from the project's `.pi`.
See the JSON files for current values rather than maintaining duplicate lists here.

### Project capabilities

Launch Pi from the repository root and trust that project:

- This repository's `.pi/settings.json` adds `self-reload`. It does not list
  `pi-pocock-skills`, because a project entry would replace the global filter.
- `~/Work/omarchy-customizations/.pi/subagents.json` permits implementation tools,
  but not prompt replacement or peers. Its `.pi/skills/gaming-setup` supplies the
  gaming skill **only to that project**.
- Global skills in `~/.pi/agent/skills/` are the Omarchy-managed `omarchy` and
  `diagnose-crash` links. Do not reinstall the gaming skill globally.

Subagent policies are **whole-file replacements**, not overlays. Lookup uses the
parent's launch cwd and does not search parent directories. Starting Pi inside a
package subdirectory therefore does not select the root project policy.
`workingDirectories: ["."]` means the launch tree; even read tools can access
outside it. These policies reduce capabilities, not provide an OS sandbox.

Children do not inherit parent extensions or skills. Current policies deliberately
have no web-retrieval resources: for online research, the parent can retrieve cited
sources and pass them to a child, or perform a small lookup directly. Add exact
resource/tool permissions only when a task needs them.

### Models and external services

A local Halogen **parent does not imply local-only work**: the child policies allow
hosted OpenAI and xAI models; Context7 and web search also contact external services.
Choose delegation and retrieval accordingly for private material.

Parent cycling and child model choices serve different purposes. The current
child choices preserve the previously approved models rather than migrating them
just because newer parent choices exist. Concise policy descriptions are advice,
not measured success rates. Historical model-selection evidence is in
`~/Code/pi-packages/packages/subagents/proposals/`.

`models.json` intentionally contains a trusted LAN endpoint and a dummy key, not
a credential. Context-window overrides are intentional compaction limits; cost
metadata is only an estimate. Review overrides against actual use/catalog changes
before pruning them. Never put a real secret in this file.

`mcp.json` uses the mcp-client extension's Claude-style file schema:
`mcpServers` at the root and `type` on each server. The old `servers` and
`transport` keys are rejected. OAuth, if added, uses `callbackPort`, not
`redirectPort`. Edit the canonical file here, preserve the global symlink,
and `/reload` Pi after changes.

Playwright is pinned to **0.0.82**, the locally installed version reviewed on
2026-09-26. Its tools use `toolLoading: "deferred"`: `mcp_search_tools` activates
needed tools rather than injecting the whole catalog at startup. The server still
starts. Upgrade the pin deliberately and smoke-test discovery/browser operations;
`npx` may need network access on the first use of a pin.

## Link, verify and repair

```bash
./global/link.sh          # link all four files; preserve replaced files/links
./global/link.sh --check  # read-only; nonzero for invalid sources or broken links
python3 -B -m unittest discover -s global/tests
```

Requirements: Bash, GNU coreutils and `jq`. `PI_CODING_AGENT_DIR` selects a custom
agent directory; legacy `PI_AGENT_DIR` remains a fallback. A custom directory also
needs appropriately resolved package paths and separate authentication.

The linker validates all sources/destinations before modifying links. It refuses
directory targets and creates private `pi-config-backup.*` directories for replaced
files/links. Repair restores the repo version; it does **not** merge detached edits.
Inspect backups before discarding them. `--check` compares link identity, not two
reads of the same file through a symlink.

### Omarchy themes

`~/.pi/agent/themes/omarchy-system.json` is generated by Omarchy and stays untracked.
In the installed Omarchy version, ordinary `omarchy theme set` regenerates the
theme but does not rewrite settings. The explicit `omarchy-theme-set-pi --activate`
path uses a temp-file rename that replaces the settings symlink.

The defensive hook `hooks/theme-set-relink-pi-config` repairs links after theme-set
hooks run. A direct `--activate` call does **not** run that hook: run `global/link.sh`
afterward. The canonical settings already select `omarchy-system`.

Install the hook as a link (the stock hook installer copies):

```bash
mkdir -p ~/.config/omarchy/hooks/theme-set.d
ln -sfn ~/Code/pi-packages/global/hooks/theme-set-relink-pi-config \
        ~/.config/omarchy/hooks/theme-set.d/theme-set-relink-pi-config
```

The hook targets `~/.pi/agent`, matching Omarchy, even if the invoking shell has a
custom Pi agent-directory variable.

## Restore on another machine

1. Clone `pi-packages` to `~/Code/pi-packages` with `--recurse-submodules`. Follow
   its root README to install locked package dependencies with `npm ci --ignore-scripts`
   and run `scripts/check.sh` before loading extensions.
2. Run `./global/link.sh`, then install the hook link above.
3. Sign in to providers through Pi; credentials are not restored from this repo.
4. Apply an Omarchy theme to generate the Pi theme, then run `./global/link.sh --check`.
5. Start Pi from the intended project root, grant project trust, and inspect
   `/subagents diagnostics` plus `/mcp status`.

Use manual `/reload` in each existing session after configuration/resource changes.
Reload stops that session's children; finish or close them first. Moving
`self-reload` out of global settings means it is available only in the development
project after reload. Other sessions are not refreshed automatically.

## Private/generated state and retention

Keep `auth.json`, `mcp-auth/`, session transcripts, `models-store.json`, and child
runtime state out of Git. `global/.gitignore` guards against accidental copies here.
The generated theme is also excluded.

Old `*.bak.*` / `pi-config-backup.*` files and child logs/artifacts can contain private
configuration or source. Review them locally and back up useful recovery material
before manual pruning. Do not remove active parent-session directories. There is
no automatic retention/deletion job; the current volume does not justify one.
