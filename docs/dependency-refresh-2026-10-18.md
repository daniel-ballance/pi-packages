# Dependency refresh, 2026-10-18

## Scope and completion criteria

This run updates the workstation tools and the collection's 23 direct npm dependency names to their registry `latest` releases. T3 Code follows nightly. Vendored skills are already at their upstream heads, `49dd158` and `0b8e952`, and do not change in this run.

Completion requires clean npm and pnpm installs, the canonical root check under both managers, independent verification of the proposed change, a merged pull request, and local `main` equal to `origin/main`. Installed tool versions must match their selected release channels. Transitive dependencies retain upstream compatibility ranges and published Pi shrinkwraps. They are not forced across upstream major-version constraints.

## Workflow

1. Capture installed versions, registry releases, the npm dependency tree, audit results, and the baseline root check.
2. Update local Node, npm, and pnpm. Check the unchanged repository under the new tools before changing dependencies.
3. Update compiler and development dependencies, then runtime dependencies and reviewed security replacements. Refresh each standalone npm lock, the root npm lock, and the pnpm lock. Check each unit before advancing.
4. Test separate clean npm and pnpm worktrees. Exercise the real Pi loader, production packaging, the supported Node 22 line, and current Node 26.
5. Review the diff and the decision trail independently. Merge only a verified patch with passing checks. Fast-forward local `main`, install its dependencies, and verify the installed collection.
6. Update T3 nightly after delegated tasks finish, because its updater can restart the hosting service. Verify the running server after the update.

## Baseline

The baseline is `26ee3b7`. `PACKAGE_MANAGER=npm ./scripts/ci-install.sh locked` and `PACKAGE_MANAGER=npm ./scripts/check.sh` passed before edits. npm audit reported zero vulnerabilities.

| Tool | Before | Selected release |
| --- | --- | --- |
| Pi | 1.3.0 | 1.3.0 |
| Node.js | 26.9.0 | 26.12.0 |
| npm | 11.19.1 | 12.2.0 |
| pnpm | 12.6.0 | 12.14.0 |
| T3 Code | 0.1.1-nightly.20261017.3238 | 0.1.1-nightly.20261018.3302 |
| Python | 3.14.7 | 3.15.0 |
| uv | 0.13.0 | 0.13.1 |

The registry `latest` tag selects stable npm packages. `npm@next-12` is 12.2.1 but is not the selected general-availability release. Node's release index selects 26.12.0. npm 12 requires Node 22.22.2, Node 24.15.0, or Node 26 and newer, so CI must not combine npm 12 with Node 22.19.0.

## Selected npm releases

| Dependency | Previous declarations | Selected release |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | `0.3.296` | 0.3.302 |
| `@anthropic-ai/sdk` | `0.124.0` | 0.135.0 |
| `@modelcontextprotocol/node` | `2.0.0` | 2.1.1 |
| `@modelcontextprotocol/server` | `2.0.0` | 2.3.1 |
| `@types/node` | `22.20.4`, `^22.0.0` | 26.6.5 |
| `ajv` | `^8.18.0` | 8.20.0 |
| `commander` | `14.0.0` | 15.0.0 |
| `eventsource-parser` | `^3.0.6` | 4.1.2 |
| `mdast-util-from-markdown` | `2.0.3` | 2.1.0 |
| `prettier` | `3.6.2` | 3.9.10 |
| `tsx` | `^4.21.0` | 4.23.15 |
| `typebox` | `^1.0.0` | 1.4.2 |
| `typescript` | `^5.9.3` | 7.0.2 |
| `undici` | `8.10.2` | 8.12.2 |
| `zod` | `^4.3.6` | 4.6.7 |

Pi SDK packages remain at 1.3.0. The legacy MCP SDK remains at its latest 1.32.1. `brace-expansion`, `yaml`, `ajv-formats`, and `cheerio` were already current.

## Dependency contract

Runtime imports belong in each package's `dependencies`. Pi APIs remain peers with exact development SDK copies. The root npm lock governs collection installs. Child npm locks govern standalone development. pnpm has a separate root lock and disables peer auto-installation and lifecycle scripts.

The explicit SDK security patch step validates the replacement source version and integrity. Updating its undici source requires a reviewed integrity change and regression checks, not just a manifest edit. Checks never repair dependencies.

## Evidence

The append-only [decision trail](dependency-refresh-2026-10-18.tsv) records checkpoints. Local command output lives under `/tmp/pi-dependency-refresh/` during this run. These commands reproduce the main checks from an installed checkout:

```sh
npm outdated --workspaces --include-workspace-root
npm audit
PACKAGE_MANAGER=npm ./scripts/check.sh
PACKAGE_MANAGER=pnpm ./scripts/check.sh
```

Registry lookups use `npm view <name> version`. Release-channel checks use `mise latest <tool>`, `https://nodejs.org/dist/index.json`, and GitHub releases for `pingdotgg/t3code`.

## Results

The npm clean install and canonical root check pass with Node 26.12.0, npm 12.2.0, and Python 3.15.0. The dependency update also passed the root check on minimum-supported Node 22.19.0 before the final security-source correction. Final clean-manager and independent verification remain pending.

npm 12 changed `npm pack --json` from an array to a name-keyed object. The packaging test reads either shape through `Object.values`. Two assertion messages now supply an empty string when their diagnostic detail is absent, as required by the latest Node types.

The undici update initially exposed a mistaken assumption. The reviewed replacement release and the safe-installed floor shared one field. Raising both made the installer try to patch secure, unshrinkwrapped Pi 1.3.0. A new regression reproduced that failure before the correction.

Two independent design candidates compared a separate `sourceVersion` against deletion of the patch infrastructure. The cross-judge selected the field split, scoring it 7 against 4. The parent agreed because it preserves the existing security boundaries with a smaller change. The implementation keeps undici's security floor at 8.10.2, reviews the 8.12.2 source and integrity separately, and derives the output message from the dependency records. All 40 security-install tests pass. The regression verifies that secure SDKs without shrinkwraps remain byte-for-byte unchanged. Removing the historical patch infrastructure is outside this update's scope.
