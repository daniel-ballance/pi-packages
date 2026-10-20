# p3stack

The Pi package for routed engineering workflows and their runtime tools. It combines generated skills from Cursor's pstack and Matt Pocock with Pi-owned procedures, a mode extension, and six nested runtime components.

See the [repository README](../../README.md) for the frozen install, supported runtime, checks, and component list. [About p3stack](../../docs/p3stack.md) explains the registry, router, host map, and maintenance loop. Maintainers must follow [AGENTS.md](AGENTS.md).

## Install and enable

Complete the workspace dependency install before loading this local package.

```sh
pi install /path/to/pi-packages/packages/p3stack
```

The root repository is not an install identity. Do not add the nested component directories as additional packages. p3stack already loads their extensions and subagents' skills. mcp-client is not included.

Run `/p3stack on` to enable the router. In print or JSON mode, pass the command and task in the same invocation so mode state survives until the prompt. `/p3stack off` removes the mode reminder. `/p3stack status` reports its state. A terminal status row shows `p3stack on` while enabled.

`skills/p3stack-mode/SKILL.md` chooses the route, then reads poteto-mode and the selected procedure. Pocock's `tdd` keeps its name. pstack's older `tdd` is emitted as `regression-test`. The registry decides names and exclusions before loading, with no global skill filters.

## Resolve role models

`/p3stack-setup` selects role defaults in a terminal. Under T3, use `/skill:setup-pstack` to read its catalog. The role file is `~/.pi/agent/p3stack.json`, or `.pi/p3stack.json` in a trusted project.

`p3stack_roles` resolves hints against the live catalog. The mode reminder asks for that tool rather than copying a static role table into every prompt. A project-local role file is ignored when the project is untrusted.

## Use the host contract

The skills name capabilities and read [`host-capabilities.md`](skills/poteto-mode/references/host-capabilities.md) for the operation on their host. Terminal sessions use the nested subagents component. T3 supplies delegation and scheduling, and subagents stays inactive there.

A personal `subagents.json` replaces built-in policy as a whole. Its extension allowlist and `providerExtensions` mapping must name the moved Claude provider path when children use that provider. See the [configuration reference](subagents/skills/subagents/reference/configuration.md). Policy does not provide an OS sandbox.

T3 uses the same single-package settings, but its explicit provider launch argument also needs the moved extension path. Follow the [landing instructions](docs/landing/t3-settings.md) after the stack lands. Do not point a live provider at an unlanded worktree.

## Run helper scripts

The playbook helpers run under Node.js 22.19.0 or newer. Node does not strip TypeScript inside `node_modules`, so use a local checkout or a Git checkout rather than an npm-installed copy. The frozen workspace install supplies `commander`. `watch-pr` needs `gh`. `worktree-audit.sh` needs `git`, `jq`, and `gh`.

Generated upstream output lives in `skills/`. Change its rules or authored inputs, then regenerate. Never edit generated output directly.

## Maintain p3stack

Run `/skill:maintain-p3stack` to audit current pins and the authored registry. A clean audit reports each source, changes no files, and opens no PR. It does not claim that remote upstream is unchanged.

Request an explicit upstream bump to continue through scope review, generator repairs, checks, and an unmerged source-update PR. Sources sharing a checkout stay in one PR. Independent sources get separate PRs. See the [procedure](authored/skills/maintain-p3stack/SKILL.md), [nightly prompt](authored/skills/maintain-p3stack/references/nightly.md), and [bump notes](docs/bumps/README.md).

## License

MIT. See [LICENSE](LICENSE) and [LICENSE-matt-pocock](LICENSE-matt-pocock). Upstream pins follow.

<!-- p3stack:upstream -->`cursor/plugins` [`88d4751`](https://github.com/cursor/plugins/tree/88d47514b82e7c44f00f2b2a72ff6dd12158038c/pstack), pstack 0.15.29; `mattpocock/skills` [`5beb35b`](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2); `cursor/plugins` [`88d4751`](https://github.com/cursor/plugins/tree/88d47514b82e7c44f00f2b2a72ff6dd12158038c)<!-- /p3stack:upstream -->.
