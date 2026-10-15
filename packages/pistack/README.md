# pistack

The Pi edition of [pstack](https://github.com/cursor/plugins/tree/e5136d82418d2db3165ea1050d17577cd618cc05/pstack),
Lauren Tan's Cursor plugin: a router mode, playbooks, principles and routed
skills for rigorous, parallel agent work. pistack is generated from the vendored
upstream and translated for Pi in a terminal and for Pi launched by T3 Code.
Maintainers: see [AGENTS.md](AGENTS.md).

**Status:** every upstream skill, playbook, principle, agent recipe and helper
script is generated, except `make-bot-ui` (Cursor's Grok Bot routines).
Upstream's `docs/guide` and `automations/benny` are not included; skills link to
the pinned upstream guide instead.

## Helper scripts

The playbooks' scripts (`orch`, `watch-pr`, `check-plan`, `worktree-audit`) run
under Node 22.19 or newer, which runs TypeScript directly. Node does not do that
for files inside `node_modules`, so use pistack from a local path or a Git
install, not from an npm-installed copy. After a local-path install, run
`npm install --omit=dev` in the package for `commander`. `watch-pr` needs `gh`;
`worktree-audit.sh` needs `git`, `jq` and `gh`, and works on Linux and macOS.

## Install

pistack is not part of the root collection manifest. Install it on its own:

```sh
pi install /path/to/pi-packages/packages/pistack
```

Skills arrive as `/skill:<name>`. pstack's workflow skills set
`disable-model-invocation: true`, so they cost no prompt space until invoked.

pistack ships its own `tdd` skill. If you also enable `agent-skills`' `tdd`, Pi
keeps whichever it discovers first and warns; enable one of them.

## Extension

The package also loads a small hand-written extension:

| Piece | Does |
|---|---|
| `/pistack-mode on\|off\|status` | Keeps poteto-mode on across turns: while on, a prompt section tells the model to read `skills/poteto-mode/SKILL.md` and follow its playbooks, and every `subagent_spawn` or T3 `delegate_task` brief starts with the [poteto-agent recipe](agents/poteto-agent.md). The setting follows the session branch; the status bar shows it where there is a UI. |
| `ask_user` | Asks the human a product or preference question, with choices or free text. Works in a terminal and under T3 Code (T3 shows Pi's dialogs as pending requests); without a UI it tells the model to apply its stated default and say so. |
| `pistack_roles` | Returns the model for every pistack role, from `.pi/pistack.json` in a trusted project, else `~/.pi/agent/pistack.json`, else the skills' default hints. |
| `/pistack-setup` | In a terminal: pick a thinking budget, a code model and a judgment model, and write `~/.pi/agent/pistack.json` for every role. Each model is offered at the highest thinking level it supports within the budget, or not at all. With subagents loaded, only identities its allowlist permits are offered (read over Pi's event bus; an older subagents that cannot answer gets a pointer to the skill). Under T3 it points to `/skill:setup-pstack`, which can read T3's catalog. |

`/loop` and the todo list come from the `subagents` and `todo` packages, not from here.

## Hosts

Skills name capabilities (delegate, isolate, ask, todo) and resolve them through
[`skills/poteto-mode/references/host-capabilities.md`](skills/poteto-mode/references/host-capabilities.md):

- **Pi in a terminal** delegates through the `subagents` package.
- **Pi under T3 Code** delegates through T3's `delegate_task` and related tools.

## License

MIT, from upstream; see [LICENSE](LICENSE). Upstream pin: `cursor/plugins`
`e5136d8`, pstack 0.15.25.
