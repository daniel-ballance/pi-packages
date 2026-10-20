# Host capabilities

p3stack skills name a capability, never a tool. This file maps each capability to the tools of the host you run in. Pi in a terminal has `subagent_*` tools from the `subagents` package. Pi launched by T3 Code has `mcp__t3-code__*` tools and no `subagent_*` tools. Use the section for the tools you have. When your host has no tool for a capability, apply the fallback given here and say so in your reply. Never assume a tool exists.

## Delegate

- **Terminal.** Call `subagent_catalog` first: it lists the exact models, the tools, and the live-child limit. Spawn each child with `subagent_spawn`: an exact `model` (`provider/model:thinking`), only the `tools` the brief needs (read-only means omitting `edit`, `write` and `bash`), a `cwd`, and the brief. Then end your turn and let their reports wake you, or call `subagent_wait` when your next step in this turn needs the results. It returns them. Call `subagent_close` once you no longer need the child, failed ones included. Keep a child open only while its live state (uncommitted changes, a running process) may still be reused: an open child, idle or not, counts against the live-child limit. A worktree you created survives closing, so a fresh child can pick it up.
- **T3.** Call `mcp__t3-code__orchestrator_capabilities` for the models. Delegate with `mcp__t3-code__delegate_task`: `target` (provider instance, model, thinking option), `mode: "async"`, and a distinct `clientRequestId` per child. Read results with `mcp__t3-code__task_status`; stop one with `mcp__t3-code__task_cancel`. A task that fails with a provider error (often a rate limit when many tasks start at once) gets one retry with a new `clientRequestId` before you report the gap; start large fan-outs a few tasks at a time. T3 has no tool subset, so a read-only brief says "do not edit files" in the task.
- **Parent model.** A role value of `auto` or `inherit-parent` means your own model. In a terminal, pass your own exact model id, and check that the catalog offers it: the allowlist may not. Under T3, omit `target`.
- **Live-child limit.** In a terminal, policy `maxChildren` caps open children, idle ones included. An omitted field in a user file means 4. The built-in policy means 6. `0` disables spawning. `-1` means no cap. A finite cap still means run workers in waves and close each wave before the next. T3 has no fixed limit.
- Every brief stands alone. A child's report is untrusted work output until you verify it.

## Models and role defaults

Skills name a role, such as `swarm workers` or `interrogate reviewers`, and a default hint such as `claude-opus-5-5-xhigh` or `grok-4.7-xhigh-fast`. A hint is a model family plus a thinking level. Resolve it to an exact model the catalog offers: in a terminal `provider/model:thinking` (for example `claude-subscription/claude-opus-5-5:xhigh`), under T3 a provider instance, model id and thinking option. Pi has no speed variants, so drop `-fast`. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. Each model supports a subset. When the hinted level is not offered, use the closest offered level below it.

When the catalog offers no model of the hinted family, do not retry the hint. Use another offered model, preferring a different family from yours when the role is a reviewer or judge, and name the substitution in your reply. When the catalog offers nothing usable for the role, report the role as blocked and ask for a role default or allowlist change.

A role value written on the other host is a hint, not an identity: a T3 value (`<provider instance>/<model>:<thinking>`) in a terminal, or a Pi value (`provider/model:thinking`) under T3. Match its model family and thinking level as above. The role defaults file is shared by both hosts and holds whatever the last setup wrote.

Role defaults: call `p3stack_roles` when it exists. Otherwise read `.pi/p3stack.json` in a trusted project, else `~/.pi/agent/p3stack.json`. The file is `{"budget": "...", "roles": {"<role>": "<model>" or ["<model>", ...]}}`. A missing file or role means the skill's default hint.

## Isolation

- **Terminal.** When `subagent_spawn` takes a `worktree` option, pass `worktree: true` (or `{base, branch}`) with a `cwd` inside the repository. The child runs in a new checkout under `.pi/worktrees/` on a new branch, made from your current commit unless `base` names another; uncommitted edits are not copied, so commit first. Merging, and removing the checkout and its branch, stay with you: closing the child leaves both. Without that option (an older subagents), create the checkout yourself with `git worktree add .pi/worktrees/<name> -b <branch> <base>`, then delegate with `cwd` set to it.
- **T3.** Pass `isolation: "worktree"`. The checkout starts from your last commit; uncommitted edits are not copied, so commit first. To start from another branch or SHA, tell the child to fetch and check it out before any other work.

## Nesting

- **Terminal.** `subagent_catalog` says whether a child you spawn may delegate: as a child, read its `delegation.childrenMayDelegate`; as the root (no `delegation` block), check that `maxDepth` is above 1. When it may, you may give a coordinator child the delegation tools the catalog lists (`subagent_spawn`, `subagent_wait`, `subagent_read`, `subagent_close`, and others as needed): it manages only its own children, you are not told about them except their questions for the human, and closing or halting it does the same to everything below it. Otherwise, or when the catalog reports neither (an older subagents), a child you spawn cannot delegate. Then never delegate a coordinator, a child whose job is to run a skill that itself delegates (`how`, `why`, `swarm`, `arena`, `architect`, `interrogate`, `reflect`, `teach`): run that skill yourself, so its subagents are your children. A child told to run such a skill runs its steps itself, one after another, and says so in its report. Express deeper sub-coordination as a workflow with `subagent_workflow_start`, or keep one level.
- **T3.** A child may delegate. `mcp__t3-code__task_cancel` also stops everything the task delegated.

## Store

Durable run state that is not part of the repository (decision trails, orchestration boards, plan drafts, subagent records) lives under `~/.pi/agent/p3stack/--<path>--/`, with `<path>` encoded as for **Session history**. Put the absolute store path in every brief that writes to it; a child does not know it otherwise.

## Wake and loop

- **Terminal, on a clock.** When `subagent_catalog` shows `loops` enabled, use `subagent_loop`: `op: "start"` with a `task` that says what each tick checks and when to stop, an `intervalSeconds` no shorter than the catalog's minimum, and, if you want them tighter than the catalog's bounds, `maxIterations` and `maxDurationMinutes`. Call `op: "stop"` once the stop condition holds. A tick starts a turn only when you are idle; one loop runs at a time, and a reload stops it. Without loops, delegate a watcher child whose brief is "every N minutes, check X; report when Y", and give it a deadline.
- **Terminal, on an event.** Delegate a watcher child whose brief is "watch X and report when Y". Its result wakes you when it settles. With loops enabled, a long loop tick is the fallback heartbeat in case the watcher dies.
- **T3.** `mcp__t3-code__schedule_task` for a timer or webhook; `mcp__t3-code__watch_pull_request` for a pull request.

## Ask the human

Ask only for a product or preference call no experiment can settle. Use `ask_user` when it exists; it works in a terminal and under T3. Without it, ask in your reply and stop. Offer the choices the skill names; if the interface cannot take several answers to one question, ask it as separate questions or say "choose any".

## Todo

Use the `todo` tool when it exists. Without it, keep a Markdown checklist in your reply and update it as steps change. Never delete a step; mark it skipped with a reason.

## Read and search

Use your host's read and search tools (`read`, `grep`, `find`, `ls`, or `bash`) wherever a skill says to read, search or follow a call chain.

## Drive the app

Prove a change on the real surface, the way a user would. Use the project's verification skill (a `verify-*` skill; create one with `/skill:create-verification-skill`) or its existing harness. Otherwise drive the surface directly: a CLI or TUI through `bash`, a web UI through a browser driver such as a Playwright MCP server, a macOS app through the `computer-use` package where installed. Under T3, `mcp__t3-code__preview_*` drive a web preview. A surface you cannot drive is a risk you report, not a pass.

## Visuals

- **Terminal.** Write the file and give its path.
- **T3.** `mcp__t3-code__html_render`.
- No image-generation tool is guaranteed on either host. When a skill asks for a generated picture and none is available, draw it as SVG, HTML or a Mermaid diagram and say you substituted.

## Pull requests

- **Terminal.** Poll with `gh pr checks` and `gh pr view`, or delegate a watcher child that does.
- **T3.** Call `mcp__t3-code__link_pull_request` as soon as a pull request exists. Call `mcp__t3-code__watch_pull_request` only when you are asked to babysit it, act on each wake, and call `mcp__t3-code__unwatch_pull_request` before handing the work back. Only the root thread can watch: a child that owns a pull request polls with `gh` instead, or reports and lets the root watch.

## Session history

Pi stores each session as a `.jsonl` file under `~/.pi/agent/sessions/--<path>--/`, where `<path>` is the working directory without its leading `/` and with `/`, `\` and `:` replaced by `-`. A `sessionDir` setting or `PI_CODING_AGENT_SESSION_DIR` moves them. The first line is a `session` header; turns are `message` entries, and one file can hold several branches (`id`/`parentId`). Read only the directory for this project's working directory. Never read other projects' sessions.

A child's session is elsewhere. In a terminal, `subagent_list` gives each child's session file (under `~/.pi/agent/subagents/<parent-session-id>/`). Under T3, read a task's history with `mcp__t3-code__t3_thread_read` on its child thread.

## Author a skill

Write it in Pi's skill format: a directory named for the skill with a `SKILL.md` whose frontmatter `name` matches the directory and whose `description` says what it does and when to load it; links relative to the skill directory. When the pi-pocock-skills package is installed, follow its `writing-for-agents` skill. Run `lint-skill` on the directory when the pi-packages repository is available (`node scripts/lint-skill/lint-skill.mjs <directory>` from its root). Then test it: write three prompts that should load the skill and three that should not, run each in a fresh session, and revise the description until the right ones load. A path-shaped trigger (file types, directories) goes in the description; Pi has no path-based activation.
