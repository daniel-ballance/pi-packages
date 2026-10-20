# p3stack

The Pi edition of [pstack](https://github.com/cursor/plugins/tree/main/pstack),
Lauren Tan's Cursor plugin: a router mode, playbooks, principles and routed
skills for rigorous, parallel agent work. p3stack is generated from the vendored
upstream and translated for Pi in a terminal and for Pi launched by T3 Code.
Maintainers: see [AGENTS.md](AGENTS.md).

This package is unrelated to the npm package of the same name by RealSid08. This repository is private and is never published to npm.

**Status:** every upstream skill, playbook, principle, agent recipe and helper
script is generated, except `make-bot-ui` (Cursor's Grok Bot routines).
Upstream's `docs/guide` and `automations/benny` are not included; skills link to
the pinned upstream guide instead.

## Helper scripts

The playbooks' scripts (`orch`, `watch-pr`, `check-plan`, `worktree-audit`) run
under Node 22.19 or newer, which runs TypeScript directly. Node does not do that
for files inside `node_modules`, so use p3stack from a local path or a Git
install, not from an npm-installed copy. After a local-path install, run
`npm install --omit=dev` in the package for `commander`. `watch-pr` needs `gh`;
`worktree-audit.sh` needs `git`, `jq` and `gh`, and works on Linux and macOS.

## Install

The collection installs p3stack, along with `subagents` and `todo`. To install it without the rest of the collection:

```sh
pi install /path/to/pi-packages/packages/p3stack
```

Skills arrive as `/skill:<name>`. pstack's workflow skills set
`disable-model-invocation: true`, so they cost no prompt space until invoked.

p3stack ships its own `tdd` skill, and poteto-mode refers to the skill only by name.
The collection leaves out `pi-pocock-skills`' `tdd`, so p3stack's is the one that loads.
If you install both packages yourself, exclude `pi-pocock-skills`' `tdd`
(`"!skills/tdd/SKILL.md"` in its entry). Pi keeps whichever it discovers first and warns.

A collection install that filters resources needs p3stack's and todo's entries
in its lists, for example:

```json
{
  "source": "https://github.com/daniel-ballance/pi-packages",
  "extensions": ["packages/subagents/extensions/subagents/index.ts", "packages/todo/extensions/todo/index.ts", "packages/p3stack/extensions/p3stack/index.ts"],
  "skills": ["packages/subagents/skills/subagents/SKILL.md", "packages/p3stack/skills/*/SKILL.md"]
}
```

That pattern also loads p3stack's own `tdd`. If the list also selects `pi-pocock-skills`' skills,
add `"!packages/pi-pocock-skills/skills/tdd/SKILL.md"` so only p3stack's loads.

## Extension

The package also loads a small hand-written extension:

| Piece | Does |
|---|---|
| `/p3stack on\|off\|status` | Keeps poteto-mode on across turns and session branches. The prompt section contains only the router skill path. A hidden reminder tells the model to call `p3stack_roles` before delegation. The TUI directory line starts with `🅿️ ` while enabled, without an added status row. Turning it off restores Pi's stock footer. Toggle notices read `p3stack is on.` or `p3stack is off.`. T3, RPC, JSON, and print modes do not set a footer or status. |
| `ask_user` | Asks the human a product or preference question, with choices or free text. Works in a terminal and under T3 Code (T3 shows Pi's dialogs as pending requests); without a UI it tells the model to apply its stated default and say so. |
| `p3stack_roles` | Reads role hints from `.pi/p3stack.json` in a trusted project, else `~/.pi/agent/p3stack.json`, else the skill defaults. Resolves them against the live T3 catalog when its tool is registered, otherwise the subagents catalog over Pi's event bus. A failed T3 tool call reports a problem and falls back to the subagents catalog. Without either catalog, uses Pi's available models. Returns exact `provider/model:thinking` identities or ready T3 targets. Reports unavailable roles and skipped untrusted project files. |
| `/p3stack doctor` | Writes `~/.pi/agent/p3stack/t3-contract.json` with all registered T3 tool names and exposures, the SHA-256 of `T3_PI_MCP_EXTENSION_PATH`, and whether explicit extension arguments load claude-subscription before that bridge. Missing bridge configuration appears in `problems`. |
| `/p3stack-setup` | In a terminal: pick a thinking budget, a code model and a judgment model, and write `~/.pi/agent/p3stack.json` for every role. Each model is offered at the highest thinking level it supports within the budget, or not at all. With subagents loaded, only identities its allowlist permits are offered (read over Pi's event bus; an older subagents that cannot answer gets a pointer to the skill). Under T3 it points to `/skill:setup-pstack`, which can read T3's catalog. |

While the mode is on, delegated briefs start with the [poteto-agent recipe](agents/poteto-agent.md). Native children given none of `edit`, `write`, or `subagent_spawn` get a short read-only recipe instead. T3 tasks with `role` set to `research` or `review` get the same short recipe. Other T3 roles keep the full recipe. A prefixed brief is not prefixed again.

Wake loops and the todo list come from the `subagents` and `todo` packages, not from here.

## Using p3stack in a terminal and under T3 Code

The skills are the same on both hosts. They name a capability (delegate,
isolate, wake, ask, todo) and look up the tool for it in
[`host-capabilities.md`](skills/poteto-mode/references/host-capabilities.md).
p3stack tells the hosts apart by `T3_MCP_URL`, which T3 sets when it launches Pi.

### In a terminal

Delegation comes from the `subagents` package, and p3stack can only use what its
allowlist permits.

1. Install the collection, which includes `subagents`, `todo` and `p3stack`,
   following the repository's [install steps](../../README.md#install-in-pi):

   ```sh
   pi install https://github.com/daniel-ballance/pi-packages
   ```

   Install either the collection or the individual packages, not both.

   From a local checkout instead, run the repository's install first: Pi does
   not run npm for local paths. Then restart Pi or run `/reload`.
2. With no `subagents.json`, subagents' built-in policy already suits p3stack:
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
5. Run `/p3stack-setup`. It offers only models the allowlist permits and writes
   `~/.pi/agent/p3stack.json`.
6. Turn the mode on with `/p3stack on`. It stays on for the session branch. In print mode, pass it and the task in one invocation (`pi -p "/p3stack on" "<task>"`): Pi saves nothing until the model replies, so a run with only the command forgets it.

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

1. Install `todo` and `p3stack` as above. T3 launches Pi with your Pi
   configuration, so the same installs load.
2. T3 runs Pi in RPC mode, which cannot show Pi's project-trust prompt. A
   project's `.pi/settings.json` and `.pi/p3stack.json` load only if you saved a
   trust decision for it: run `/trust` once from that project in a terminal Pi.
3. Run `/skill:setup-pstack` in a T3 thread. It reads T3's model catalog, which
   only the model can do; `/p3stack-setup` points you there. It asks its
   questions as T3 pending requests.
4. Turn the mode on in each thread with `/p3stack on`.

### What differs

| | Terminal | T3 Code |
|---|---|---|
| Restrict a Child's tools | Yes, per Child | No: a read-only brief says "do not edit" |
| Open Children at once | `maxChildren`. A user file defaults to 4 and the built-in policy is 6. `0` turns spawning off and `-1` means no cap. | No fixed limit |
| Nesting | Needs `maxDepth` above 1 | Always on |
| Timers | Needs `loops` | `schedule_task` |
| Watch a pull request | `gh` polling, or a watcher Child | `watch_pull_request`, from the top-level thread only; a delegated task polls with `gh` |
| Model setup | `/p3stack-setup` | `/skill:setup-pstack` |
| `ask_user` | Terminal dialog | Shown in T3 as a pending request |
| Todo widget and p3stack footer prefix | Shown | Not shown. Tool results carry the todo text, and `/p3stack status` reports the mode. |

### One role file for both hosts

Both hosts read `~/.pi/agent/p3stack.json`, or `.pi/p3stack.json` in a trusted
project. The role table is not injected into each turn. `p3stack_roles` resolves the file's hints when called. It drops the `-fast` hint and selects an offered thinking level at or below the requested level for the same model. It never substitutes another model family. `auto` and `inherit-parent` require the parent's selection in the live catalog. Unavailable roles are omitted from `roles` and explained in `problems`. If you mostly use one host, run setup there.

`PI_CODING_AGENT_DIR` replaces `~/.pi/agent` for role files, setup, and doctor reports.

## Maintain p3stack

Run `/skill:maintain-p3stack` to audit the current pins for every vendored source and the authored registry. A clean audit prints a status for each source, changes no files, and opens no PR. It does not claim that remote upstream is unchanged.

Request an upstream-tip bump to continue through scope review, generator repairs, checks, and source update PRs. The procedure never merges or installs tools. Sources that share a checkout stay in one PR. Independent sources get separate PRs. See the [maintenance procedure](authored/skills/maintain-p3stack/SKILL.md), [nightly task prompt](authored/skills/maintain-p3stack/references/nightly.md), and [bump notes](docs/bumps/README.md).

## License

MIT, from upstream; see [LICENSE](LICENSE). Upstream pin:
<!-- p3stack:upstream -->`cursor/plugins` [`88d4751`](https://github.com/cursor/plugins/tree/88d47514b82e7c44f00f2b2a72ff6dd12158038c/pstack), pstack 0.15.29; `mattpocock/skills` [`5beb35b`](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2); `cursor/plugins` [`88d4751`](https://github.com/cursor/plugins/tree/88d47514b82e7c44f00f2b2a72ff6dd12158038c)<!-- /p3stack:upstream -->.
