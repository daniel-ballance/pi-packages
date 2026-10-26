# p3stack

Pi packages for routed engineering workflows, child agents, task tracking, web search, runtime reload, Claude subscription models, and optional macOS computer use.

`p3stack` is unrelated to [RealSid08/p3stack](https://github.com/RealSid08/p3stack).

The repository root is the Pi package. It loads five packages: [`claude-subscription`](packages/claude-subscription/README.md), [`p3stack`](packages/p3stack/README.md), [`computer-use`](packages/computer-use/README.md), [`self-reload`](packages/self-reload/README.md), and [`web-search`](packages/web-search/README.md). [`mcp-client`](packages/mcp-client/README.md) stays separate as an optional replacement for Pi's built-in MCP client.

## Install from GitHub

Use Node.js 22.19.0 or newer and Pi 1.3.0.

```sh
pi install git:github.com/daniel-ballance/pi-packages
```

Pi clones the repository into `~/.pi/agent/git/github.com/daniel-ballance/pi-packages` without its submodules. It then runs one production `npm install` at the clone's root, which installs every package's runtime dependencies. `pi update` updates the clone in place.

## Install from a checkout

```sh
git clone --recurse-submodules https://github.com/daniel-ballance/pi-packages.git
cd pi-packages
npm ci --ignore-scripts
node scripts/patch-pi-host-security.mts
./scripts/check.sh
pi install "$PWD"
```

Pi references local paths without installing their dependencies. Complete the frozen workspace install before loading the package. Run `/reload` in an existing Pi session after changing resources. Reload stops that session's children, so finish or close them first.

Each package also installs alone. Do not configure two copies of the repository, such as the Git source and a checkout. Pi then loads each extension twice, and a tool registered twice stops Pi from starting.

Run `pi list` to inspect configured packages. Run `/p3stack on` to enable the router. `/p3stack off` disables it. `/p3stack-setup` selects role defaults in `p3stack.json`.

The owner's nonsecret preferences live in [`global/`](global/README.md). Those files are linked from the stable checkout into the live home, not from development worktrees. [Configure T3 on each machine](packages/p3stack/docs/landing/t3-settings.md) covers the T3 launch argument for both install methods.

## Included resources

- [`extensions/p3stack`](packages/p3stack/extensions/p3stack/) owns the mode, `ask_user`, role resolution, and host diagnostics.
- [`skills`](packages/p3stack/skills/) contains the generated router and engineering workflows from the pinned Cursor and Matt Pocock sources.
- [`subagents`](packages/p3stack/subagents/README.md) owns persistent RPC children, peer messaging, bounded workflows, and recovery. It stays inactive under T3, which supplies delegation.
- [`todo`](packages/p3stack/todo/README.md) tracks steps per session branch.
- [`web-search`](packages/web-search/README.md) searches DuckDuckGo without an API key.
- [`self-reload`](packages/self-reload/README.md) reloads Pi with automatic continuation.
- [`claude-subscription`](packages/claude-subscription/README.md) provides Claude models through the Claude Agent SDK and Claude Code login. Read its billing note before use.
- [`computer-use`](packages/computer-use/README.md) uses the installed macOS Computer Use Companion locally, or over SSH with `PI_COMPUTER_USE_SSH`. No MCP entry or bridge is required. Local mode stays inactive when the required applications are absent.

Native Pi reads `mcp.json`. The root package does not load mcp-client or replace `/mcp`. The optional replacement has a different protocol stack, configuration limits, and timeout units. Read its migration notes before enabling it.

## Package structure

`package.json` lists the five packages in `piBundle`, in load order, with claude-subscription first. Each package's own `pi` block lists its resources. [`scripts/root-package.mjs`](scripts/root-package.mjs) writes the root `pi` block from those blocks, and the root check fails when the root block is stale. To add a package to the default install, add its directory to `piBundle`, run `node scripts/root-package.mjs`, and commit `package.json`.

p3stack nests its subagents and todo components, and its own manifest loads them. claude-subscription, computer-use, self-reload, and web-search are top-level packages. Each package keeps its manifest, tests, resource directories, and standalone npm lockfile. Each declares its own runtime dependencies. Pi-provided APIs remain peers. The root supports npm and pnpm workspaces, including `packages/p3stack/*`.

`.npmrc` sets `ignore-scripts=true`, so Pi's production install of a Git clone runs no lifecycle scripts, as in CI. npm uses a hoisted workspace layout. npm 12.2.0's nested install strategy omitted dependencies of nested workspaces in this layout. Tests resolve the installed Pi SDK rather than assume a physical package-local `node_modules` directory. pnpm retains its isolated dependency layout.

## Develop and verify

Choose one package manager per checkout. Both root lockfiles are committed.

```sh
npm ci --ignore-scripts
node scripts/patch-pi-host-security.mts
./scripts/check.sh
```

The pnpm alternative is `pnpm install --frozen-lockfile --ignore-scripts`, followed by the same security step and root check. CI selects Node.js 22.23.3 or 26.12.0, npm 12.2.0 or pnpm 12.14.0, and the locked Pi 1.3.0 SDK. [`scripts/ci-install.sh locked`](scripts/ci-install.sh) implements that installation contract.

`npm run check` and `pnpm run check` wrap the root gate. The gate validates configuration JSON, generated shared copies, global link tests, the registry, the static T3 contract, and every top-level and nested component's `check` and `test` scripts. It also runs the skill linter tests and mcp-client's format check. It does not need a globally installed Pi, live credentials, or paid provider calls.

Run a component's suite directly from its new path.

```sh
npm --prefix packages/p3stack/subagents run check
npm --prefix packages/p3stack/subagents test
```

Packaging tests use Pi's real loader and inspect tarball contents. They install `git:github.com/daniel-ballance/pi-packages` from a local bare repository of the tracked files, with production dependencies. npm fixtures use the cache primed by the initial install. pnpm CI also tests a frozen production install and allows npm fixture downloads because the caches are separate.

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
