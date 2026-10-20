# p3stack

One Pi package for routed engineering workflows, child agents, task tracking, web search, runtime reload, Claude subscription models, and optional macOS computer use.

`p3stack` is unrelated to [RealSid08/p3stack](https://github.com/RealSid08/p3stack).

The installable package is [`packages/p3stack/`](packages/p3stack/README.md). The repository root owns workspaces and checks, not a second Pi package identity. [`mcp-client`](packages/mcp-client/README.md) stays separate as an optional replacement for Pi's built-in MCP client.

## Install from a checkout

Use Node.js 22.19.0 or newer and Pi 1.3.0.

```sh
git clone --recurse-submodules https://github.com/daniel-ballance/pi-packages.git
cd pi-packages
npm ci --ignore-scripts
node scripts/patch-pi-host-security.mts
./scripts/check.sh
pi install "$PWD/packages/p3stack"
```

Pi references local paths without installing their dependencies. Complete the frozen workspace install before loading the package. Run `/reload` in an existing Pi session after changing resources. Reload stops that session's children, so finish or close them first.

Do not also install the nested component directories. They remain separate development workspaces with their own tests, but the p3stack manifest already loads their extensions.

Run `pi list` to inspect configured packages. Run `/p3stack on` to enable the router. `/p3stack off` disables it. `/p3stack-setup` selects role defaults in `p3stack.json`.

The owner's nonsecret preferences live in [`global/`](global/README.md). Those files are linked from the stable checkout into the live home, not from development worktrees. [Landing steps](packages/p3stack/docs/landing/t3-settings.md) cover the deferred T3 argument changes.

## Included resources

- [`extensions/p3stack`](packages/p3stack/extensions/p3stack/) owns the mode, `ask_user`, role resolution, and host diagnostics.
- [`skills`](packages/p3stack/skills/) contains the generated router and engineering workflows from the pinned Cursor and Matt Pocock sources.
- [`subagents`](packages/p3stack/subagents/README.md) owns persistent RPC children, peer messaging, bounded workflows, and recovery. It stays inactive under T3, which supplies delegation.
- [`todo`](packages/p3stack/todo/README.md) tracks steps per session branch.
- [`web-search`](packages/p3stack/web-search/README.md) searches DuckDuckGo without an API key.
- [`self-reload`](packages/p3stack/self-reload/README.md) reloads Pi with automatic continuation.
- [`claude-subscription`](packages/p3stack/claude-subscription/README.md) provides Claude models through the Claude Agent SDK and Claude Code login. Read its billing note before use.
- [`computer-use`](packages/p3stack/computer-use/README.md) uses the installed macOS Computer Use Companion. It stays inactive when the required applications are absent.

Native Pi reads `mcp.json`. p3stack does not load mcp-client or replace `/mcp`. The optional replacement has a different protocol stack, configuration limits, and timeout units. Read its migration notes before enabling it.

## Package structure

The six runtime components moved with `git mv`. Their implementations did not merge. Each keeps its manifest, tests, resource directories, and standalone npm lockfile. The p3stack manifest lists their extension entry points and the p3stack and subagents skill trees.

Runtime dependencies needed by the shipped extensions are also declared on p3stack so its tarball works without development workspaces. Pi-provided APIs remain peers in the component manifests. The root supports npm and pnpm workspaces, including `packages/p3stack/*`.

npm uses a hoisted workspace layout. npm 12.2.0's nested install strategy omitted dependencies of nested workspaces in this layout. Tests resolve the installed Pi SDK rather than assume a physical package-local `node_modules` directory. pnpm retains its isolated dependency layout.

## Develop and verify

Choose one package manager per checkout. Both root lockfiles are committed.

```sh
npm ci --ignore-scripts
node scripts/patch-pi-host-security.mts
./scripts/check.sh
```

The pnpm alternative is `pnpm install --frozen-lockfile --ignore-scripts`, followed by the same security step and root check. CI selects Node.js 22.23.3 or 26.12.0, npm 12.2.0 or pnpm 12.14.0, and the locked Pi 1.3.0 SDK. [`scripts/ci-install.sh locked`](scripts/ci-install.sh) implements that installation contract.

`npm run check` and `pnpm run check` wrap the root gate. The gate validates configuration JSON, generated shared copies, global link tests, the registry, the pinned T3 contract, and every top-level and nested component's `check` and `test` scripts. It also runs the skill linter tests and mcp-client's format check. It does not need a globally installed Pi, live credentials, or paid provider calls.

Run a component's suite directly from its new path.

```sh
npm --prefix packages/p3stack/subagents run check
npm --prefix packages/p3stack/subagents test
```

Packaging tests use Pi's real loader, inspect tarball contents, and install a local Git fixture with production dependencies. npm fixtures use the cache primed by the initial install. pnpm CI also tests a frozen production install and allows npm fixture downloads because the caches are separate.

The explicit security step validates installed SDK dependencies and repairs reviewed vulnerable development copies. It does not change Pi versions, execute lifecycle scripts, patch the global runtime, or repair dependencies during checks. See [`docs/dependency-refresh-2026-10-18.md`](docs/dependency-refresh-2026-10-18.md) for refresh procedure and security floors.

Code shared by runtime components lives in [`shared/`](shared/). Edit the source, run `node scripts/sync-shared.mjs`, and commit the copies named in `shared/copies.json`. The gate fails on drift. Never edit a copy directly.

### Keep pushes gated

Enable the committed hook once per clone.

```sh
git config core.hooksPath scripts/git-hooks
```

The hook runs `./scripts/check.sh` against a clean `HEAD` and refuses a different pushed commit. Fix a failed check rather than bypass the hook. The hook setting is shared by the clone's worktrees.

## Maintain the generated workflows

[`docs/p3stack.md`](docs/p3stack.md) explains the registry, router, host map, and maintenance loop. [`packages/p3stack/AGENTS.md`](packages/p3stack/AGENTS.md) defines generated-file ownership. Use `/skill:maintain-p3stack` for current-pin audits and explicit source bumps. Never hand-edit generated `skills/`.

Model-selection research remains in the separate Pareto project at `~/Work/pareto`. It is not a runtime dependency and does not apply execution policy. The child policy is a whole-file allowlist, not an OS sandbox.
