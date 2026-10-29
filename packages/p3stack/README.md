# p3stack

The Pi package for routed engineering workflows and their runtime tools. It combines generated skills from Cursor's pstack and Matt Pocock with Pi-owned procedures, a mode extension, and the nested subagents and todo components.

See the [repository README](../../README.md) for the frozen install, supported runtime, checks, and component list. [About p3stack](../../docs/p3stack.md) explains the registry, router, host map, and maintenance loop. Maintainers must follow [AGENTS.md](AGENTS.md).

## Install and enable

The repository root installs p3stack with claude-subscription, computer-use, self-reload, and web-search. Use the root unless you want p3stack alone.

```sh
pi install git:github.com/daniel-ballance/pi-packages
```

p3stack also installs by itself. It then loads its mode extension, subagents, todo, and the p3stack and subagents skills. Complete the workspace dependency install before loading a local checkout.

```sh
pi install /path/to/pi-packages/packages/p3stack
```

Do not configure p3stack from two copies, such as the Git source and a local checkout. Pi then loads each extension twice, and a tool registered twice stops Pi from starting. mcp-client is not included.

Run `/p3stack on` to enable the router. In print or JSON mode, pass the command and task in the same invocation so mode state survives until the prompt. `/p3stack off` removes the mode reminder. `/p3stack status` reports its state. `/p3stack doctor` writes a T3 contract report to `~/.pi/agent/p3stack/t3-contract.json`: the loaded T3 tools, the T3 bridge extension's hash, and problems such as claude-subscription not loading from exactly one file. In the terminal TUI, the directory line starts with `🅿️ ` while enabled, with no added status row. Toggle notices read `p3stack is on.` or `p3stack is off.`.

`skills/p3stack-mode/SKILL.md` chooses the route, then reads poteto-mode and the selected procedure. Pocock's `tdd` keeps its name. pstack's older `tdd` is emitted as `regression-test`. The registry decides names and exclusions before loading, with no global skill filters.

## Resolve role models

`/p3stack-setup` selects role defaults in a terminal. Under T3, use `/skill:setup-pstack` to read its catalog. The role file is `~/.pi/agent/p3stack.json`, or `.pi/p3stack.json` in a trusted project.

`p3stack_roles` resolves hints against the live catalog. The mode reminder asks for that tool rather than copying a static role table into every prompt. A project-local role file is ignored when the project is untrusted.

## Use the host contract

The skills name capabilities and read [`host-capabilities.md`](skills/poteto-mode/references/host-capabilities.md) for the operation on their host. Terminal sessions use the nested subagents component. T3 supplies delegation and scheduling, and subagents stays inactive there.

A personal `subagents.json` replaces built-in policy as a whole. When children use the Claude provider, name it as `loaded:claude-subscription` in the extension allowlist and the `providerExtensions` mapping. That reference resolves to the file this parent loaded, on any machine. See the [configuration reference](subagents/skills/subagents/reference/configuration.md). Policy does not provide an OS sandbox.

T3 loads claude-subscription through a launch argument as well as the package. Follow [Configure T3 on each machine](docs/landing/t3-settings.md) so both name the same file. Do not point a live provider at an unlanded worktree.

## Run helper scripts

The playbook helpers run under Node.js 22.19.0 or newer. Node does not strip TypeScript inside `node_modules`, so use a local checkout or a Git checkout rather than an npm-installed copy. The frozen workspace install supplies `commander`. `watch-pr` needs `gh`. `worktree-audit.sh` needs `git`, `jq`, and `gh`.

Generated upstream output lives in `skills/`. Change its rules or authored inputs, then regenerate. Never edit generated output directly.

## Maintain p3stack

Run `/skill:maintain-p3stack` to audit current pins and the authored registry. A clean audit reports each source, changes no files, and opens no PR. It does not claim that remote upstream is unchanged.

Request an explicit upstream bump to continue through scope review, generator repairs, checks, and an unmerged source-update PR. Sources sharing a checkout stay in one PR. Independent sources get separate PRs. See the [procedure](authored/skills/maintain-p3stack/SKILL.md), [nightly prompt](authored/skills/maintain-p3stack/references/nightly.md), and [bump notes](docs/bumps/README.md).

## License

MIT. See [LICENSE](LICENSE) and [LICENSE-matt-pocock](LICENSE-matt-pocock). Upstream pins follow.

<!-- p3stack:upstream -->`cursor/plugins` [`1ba91fc`](https://github.com/cursor/plugins/tree/1ba91fc25c0977741dd0e267849e6234b037ed0a/pstack), pstack 0.15.36; `mattpocock/skills` [`59db609`](https://github.com/mattpocock/skills/tree/59db609eb1e18aaf59b63284d0e52255aff0c63c); `cursor/plugins` [`1ba91fc`](https://github.com/cursor/plugins/tree/1ba91fc25c0977741dd0e267849e6234b037ed0a)<!-- /p3stack:upstream -->.
