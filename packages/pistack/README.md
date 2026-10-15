# pistack

The Pi edition of [pstack](https://github.com/cursor/plugins/tree/e5136d82418d2db3165ea1050d17577cd618cc05/pstack),
Lauren Tan's Cursor plugin: a router mode, playbooks, principles and routed
skills for rigorous, parallel agent work. pistack is generated from the vendored
upstream and translated for Pi in a terminal and for Pi launched by T3 Code.
Maintainers: see [AGENTS.md](AGENTS.md).

**Status:** every upstream skill, playbook, principle and agent recipe is
generated, except `make-bot-ui` (Cursor's Grok Bot routines). Not yet included:
the helper scripts under `skills/poteto-mode/scripts/` (`orch`, `watch-pr`,
`check-plan`, `worktree-audit`), upstream's `docs/guide` and `automations/benny`.
Until they are, playbooks that run one (orchestrate, babysit, shipping,
multi-phase plan, worktree cleanup) name a file this package does not ship.

## Install

pistack is not part of the root collection manifest. Install it on its own:

```sh
pi install /path/to/pi-packages/packages/pistack
```

Skills arrive as `/skill:<name>`. pstack's workflow skills set
`disable-model-invocation: true`, so they cost no prompt space until invoked.

pistack ships its own `tdd` skill. If you also enable `agent-skills`' `tdd`, Pi
keeps whichever it discovers first and warns; enable one of them.

## Hosts

Skills name capabilities (delegate, isolate, ask, todo) and resolve them through
[`skills/poteto-mode/references/host-capabilities.md`](skills/poteto-mode/references/host-capabilities.md):

- **Pi in a terminal** delegates through the `subagents` package.
- **Pi under T3 Code** delegates through T3's `delegate_task` and related tools.

## License

MIT, from upstream; see [LICENSE](LICENSE). Upstream pin: `cursor/plugins`
`e5136d8`, pstack 0.15.25.
