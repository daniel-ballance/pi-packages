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

The collection installs pistack, along with `subagents` and `todo`. To install it without the rest of the collection:

```sh
pi install /path/to/pi-packages/packages/pistack
```

Skills arrive as `/skill:<name>`. pstack's workflow skills set
`disable-model-invocation: true`, so they cost no prompt space until invoked.

pistack ships its own `tdd` skill. The collection leaves it out, so `pi-pocock-skills`'
`tdd` is the one that loads there; poteto-mode refers to the skill only by name.
Installed on its own, pistack loads its own `tdd`. Don't also enable
`pi-pocock-skills`' `tdd` in that case: Pi keeps whichever it discovers first and warns.

A collection install that filters resources needs pistack's and todo's entries
in its lists, for example:

```json
{
  "source": "https://github.com/daniel-ballance/pi-packages",
  "extensions": ["packages/subagents/extensions/subagents/index.ts", "packages/todo/extensions/todo/index.ts", "packages/pistack/extensions/pistack/index.ts"],
  "skills": ["packages/subagents/skills/subagents/SKILL.md", "packages/pistack/skills/*/SKILL.md"]
}
```

That pattern also loads pistack's own `tdd`. If the list selects `pi-pocock-skills`' `tdd`
too, add `"!packages/pistack/skills/tdd/SKILL.md"` so only one loads.

## Extension

The package also loads a small hand-written extension:

| Piece | Does |
|---|---|
| `/pistack-mode on\|off\|status` | Keeps poteto-mode on across turns: while on, a prompt section tells the model to read `skills/poteto-mode/SKILL.md` and follow its playbooks, and every `subagent_spawn` or T3 `delegate_task` brief starts with the [poteto-agent recipe](agents/poteto-agent.md), which has the Child read the mode skill. A terminal Child given none of `edit`, `write` or `subagent_spawn` only investigates, so it gets a short read-only recipe instead: answer the brief with evidence, no playbook, no delegation. The setting follows the session branch. In the terminal a 🥔 before the working directory on the footer's first row shows it is on. |
| `ask_user` | Asks the human a product or preference question, with choices or free text. Works in a terminal and under T3 Code (T3 shows Pi's dialogs as pending requests); without a UI it tells the model to apply its stated default and say so. |
| `pistack_roles` | Returns the model for every pistack role, from `.pi/pistack.json` in a trusted project, else `~/.pi/agent/pistack.json`, else the skills' default hints. |
| `/pistack-setup` | In a terminal: pick a thinking budget, a code model and a judgment model, and write `~/.pi/agent/pistack.json` for every role. Each model is offered at the highest thinking level it supports within the budget, or not at all. With subagents loaded, only identities its allowlist permits are offered (read over Pi's event bus; an older subagents that cannot answer gets a pointer to the skill). Under T3 it points to `/skill:setup-pstack`, which can read T3's catalog. |

Wake loops and the todo list come from the `subagents` and `todo` packages, not from here.

## Using pistack in a terminal and under T3 Code

The skills are the same on both hosts. They name a capability (delegate,
isolate, wake, ask, todo) and look up the tool for it in
[`host-capabilities.md`](skills/poteto-mode/references/host-capabilities.md).
pistack tells the hosts apart by `T3_MCP_URL`, which T3 sets when it launches Pi.

### In a terminal

Delegation comes from the `subagents` package, and pistack can only use what its
allowlist permits.

1. Install the collection, which includes `subagents`, `todo` and `pistack`,
   following the repository's [install steps](../../README.md#install-in-pi):

   ```sh
   pi install https://github.com/daniel-ballance/pi-packages
   ```

   Install either the collection or the individual packages, not both.

   From a local checkout instead, run the repository's install first: Pi does
   not run npm for local paths. Then restart Pi or run `/reload`.
2. With no `subagents.json`, subagents' built-in policy already suits pistack:
   it offers the models you can reach across the common providers (and the
   collection's `claude-subscription` models, with their extension mapped),
   gives Children the edit tools, `todo` and the delegation tools, and turns on
   nesting (`maxDepth` 2) and bounded wake loops. Skip to step 5.
3. Write `~/.pi/agent/subagents.json` only to choose differently. A file
   replaces the built-in policy whole, and in a file every optional field is
   off until you set it. List every model the roles should use, and the tools
   Children need: implementation roles edit, so a policy of only `read`,
   `grep`, `find` and `ls` gives them Children that cannot change anything. A
   model from a provider that an extension adds, such as `claude-subscription`,
   exists only in your session, because Children start with `--no-extensions`:
   allowlist the provider's extension file and map it in `providerExtensions`,
   as in the example below. Each provider also needs its own sign-in. The
   fields are in subagents'
   [configuration reference](../subagents/skills/subagents/reference/configuration.md).
4. In your own file, turn on what the playbooks expect:
   - `"maxDepth": 2` lets a Child coordinate its own Children. Orchestrate,
     autopilot and nested swarms use it; without it, those skills run their
     fan-out from your session instead. A coordinator needs the delegation tools,
     `subagent_catalog` included, in `tools`.
   - `"loops": {"enabled": true, "minIntervalMs": 60000, "maxIterations": 50, "maxDurationMs": 28800000}`
     enables `subagent_loop`, which babysit, shipping and the autopilot audit tick
     use for wake-ups. Without it they fall back to a watcher Child.
5. Run `/pistack-setup`. It offers only models the allowlist permits and writes
   `~/.pi/agent/pistack.json`.
6. Turn the mode on with `/pistack-mode on`. It stays on for the session branch. In print mode, pass it and the task in one invocation (`pi -p "/pistack-mode on" "<task>"`): Pi saves nothing until the model replies, so a run with only the command forgets it.

An example file:

```json
{
  "version": 1,
  "models": [
    { "id": "claude-subscription/claude-opus-5-5:xhigh" },
    { "id": "xai/grok-4.7:xhigh" },
    { "id": "openai-codex/gpt-6-luna:medium" }
  ],
  "tools": ["read", "grep", "find", "ls", "bash", "edit", "write", "todo",
            "subagent_catalog", "subagent_spawn", "subagent_wait", "subagent_read",
            "subagent_close", "subagent_list", "subagent_send"],
  "extensions": ["/path/to/pi-packages/packages/claude-subscription/extensions/claude-subscription/index.ts"],
  "providerExtensions": {
    "claude-subscription": "/path/to/pi-packages/packages/claude-subscription/extensions/claude-subscription/index.ts"
  },
  "maxDepth": 2,
  "loops": { "enabled": true, "minIntervalMs": 60000, "maxIterations": 50, "maxDurationMs": 28800000 }
}
```

The `subagent_*` entries matter only with `maxDepth` above 1. Each tick of a loop
starts a turn and so costs model usage.

### Under T3 Code

Delegation, worktrees, nesting, timers and pull-request watching come from T3's
own tools. `subagents` switches itself off there, so no `subagents.json` setting
applies.

1. Install `todo` and `pistack` as above. T3 launches Pi with your Pi
   configuration, so the same installs load.
2. T3 runs Pi in RPC mode, which cannot show Pi's project-trust prompt. A
   project's `.pi/settings.json` and `.pi/pistack.json` load only if you saved a
   trust decision for it: run `/trust` once from that project in a terminal Pi.
3. Run `/skill:setup-pstack` in a T3 thread. It reads T3's model catalog, which
   only the model can do; `/pistack-setup` points you there. It asks its
   questions as T3 pending requests.
4. Turn the mode on in each thread with `/pistack-mode on`.

### What differs

| | Terminal | T3 Code |
|---|---|---|
| Restrict a Child's tools | Yes, per Child | No: a read-only brief says "do not edit" |
| Open Children at once | `maxChildren` (4 by default) | No fixed limit |
| Nesting | Needs `maxDepth` above 1 | Always on |
| Timers | Needs `loops` | `schedule_task` |
| Watch a pull request | `gh` polling, or a watcher Child | `watch_pull_request`, from the top-level thread only; a delegated task polls with `gh` |
| Model setup | `/pistack-setup` | `/skill:setup-pstack` |
| `ask_user` | Terminal dialog | Shown in T3 as a pending request |
| Todo widget, poteto-mode 🥔 in the footer | Shown | Not shown: T3 ignores widgets and has no footer. Tool results carry the same text; `/pistack-mode status` reports the mode. |

### One role file for both hosts

Both hosts read `~/.pi/agent/pistack.json`, or `.pi/pistack.json` in a trusted
project. While the mode is on, the resolved table is in the model's prompt. It holds whatever the last setup wrote: Pi identities such as
`xai/grok-4.7:xhigh` from a terminal, or T3 targets from T3. On the other host a
value is treated as a hint: the model picks the closest offered model of the same
family and thinking level, and says when it substitutes. If you mostly use one
host, run setup there.

## License

MIT, from upstream; see [LICENSE](LICENSE). Upstream pin: `cursor/plugins`
`e5136d8`, pstack 0.15.25.
