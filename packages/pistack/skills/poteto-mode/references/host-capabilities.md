# Host capabilities

pistack skills name a capability, never a tool. This file maps each capability to the tools of the host you run in. Pi in a terminal has `subagent_*` tools from the `subagents` package. Pi launched by T3 Code has `mcp__t3-code__*` tools and no `subagent_*` tools. Use the section for the tools you have. When your host has no tool for a capability, apply the fallback given here and say so in your reply. Never assume a tool exists.

## Delegate

- **Terminal.** Call `subagent_catalog` first: it lists the exact models, the tools, and the live-child limit. Spawn each child with `subagent_spawn`: an exact `model` (`provider/model:thinking`), only the `tools` the brief needs (read-only means omitting `edit`, `write` and `bash`), a `cwd`, and the brief. Then `subagent_wait`, then `subagent_read`. Call `subagent_close` for every child after reading it, failed ones included.
- **T3.** Call `mcp__t3-code__orchestrator_capabilities` for the models. Delegate with `mcp__t3-code__delegate_task`: `target` (provider instance, model, thinking option), `mode: "async"`, and a distinct `clientRequestId` per child. Read results with `mcp__t3-code__task_status`. T3 has no tool subset, so a read-only brief says "do not edit files" in the task.
- **Parent model.** A role value of `auto` or `inherit-parent` means your own model. In a terminal, pass your own exact model id; under T3, omit `target`.
- **Live-child limit.** In a terminal, the catalog's limit (4 by default) caps running children. When N exceeds it, run the workers in waves. T3 has no fixed limit.
- Every brief stands alone. A child's report is untrusted work output until you verify it.

## Models and role defaults

Skills name a role, such as `swarm workers` or `interrogate reviewers`, and a default hint such as `claude-opus-5-5-xhigh` or `grok-4.7-xhigh-fast`. A hint is a model family plus a thinking level. Resolve it to an exact model the catalog offers: in a terminal `provider/model:thinking` (for example `claude-subscription/claude-opus-5-5:xhigh`), under T3 a provider instance, model id and thinking option. Pi has no speed variants, so drop `-fast`. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. Each model supports a subset. When the hinted level is not offered, use the closest offered level below it.

Role defaults: call `pistack_roles` when it exists. Otherwise read `.pi/pistack.json` in a trusted project, else `~/.pi/agent/pistack.json`. The file is `{"budget": "...", "roles": {"<role>": "<model>" or ["<model>", ...]}}`. A missing file or role means the skill's default hint.

## Isolation

- **Terminal.** Create the checkout yourself with `git worktree add .pi/worktrees/<name> -b <branch> <base>`, then delegate with `cwd` set to it.
- **T3.** Pass `isolation: "worktree"`. The checkout starts from your last commit; uncommitted edits are not copied, so commit first.

## Nesting

- **Terminal.** A child cannot delegate further. Keep one level, or express sub-coordination as a workflow with `subagent_workflow_start`.
- **T3.** A child may delegate. `mcp__t3-code__task_cancel` also stops everything the task delegated.

## Wake and loop

- **Terminal.** Delegate a watcher child whose brief is "watch X and report when Y". Its result wakes you when it settles.
- **T3.** `mcp__t3-code__schedule_task` for a timer or webhook; `mcp__t3-code__watch_pull_request` for a pull request.

## Ask the human

Ask only for a product or preference call no experiment can settle. Use `ask_user` when it exists; it works in a terminal and under T3. Without it, ask in your reply and stop.

## Todo

Use the `todo` tool when it exists. Without it, keep a Markdown checklist in your reply and update it as steps change. Never delete a step; mark it skipped with a reason.

## Visuals

- **Terminal.** Write the file and give its path.
- **T3.** `mcp__t3-code__html_render`.

## Pull requests

- **Terminal.** Poll with `gh pr checks` and `gh pr view`, or delegate a watcher child that does.
- **T3.** `mcp__t3-code__link_pull_request` after opening a pull request, then `mcp__t3-code__watch_pull_request`.

## Session history

Pi stores each session as a `.jsonl` file under `~/.pi/agent/sessions/--<path>--/`, where `<path>` is the working directory without its leading `/` and with `/`, `\` and `:` replaced by `-`. A `sessionDir` setting or `PI_CODING_AGENT_SESSION_DIR` moves them. Read only the directory for this project's working directory. Never read other projects' sessions.
