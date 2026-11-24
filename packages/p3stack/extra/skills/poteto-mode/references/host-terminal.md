# Terminal capabilities

## Delegate

Check `subagent_catalog` for spawn permission, models, tools and limits. Call `subagent_spawn` with a `name`, standalone `task`, absolute allowed `cwd`, exact catalog `model` and explicit `tools`. Select only what the brief needs, including required extensions for those tools. Use `coordination.owns` to declare work areas, not to enforce them. For a report-only child, omit delegation tools, `edit` and `write`. Omit `bash` unless the brief needs commands. Report-only is a stance, not a permission boundary: policy `alwaysTools` still apply.

Save the returned IDs. At the root, end your turn when you have nothing else to do; completion wakes you. When you need every child's result, pass their `ids` and `mode: "all"` to `subagent_wait`. `final: true` selects the last report, not when the wait returns. Check `wake` for input, holds, messages or timeout; drain unread reports with `subagent_read` and wait on outstanding IDs. A report too long to return whole carries a `readFull` handle: pass it to `subagent_read`, then each `nextRead`, until none is returned. `since` replays updates only. A coordinator child must collect its own children's results before ending its turn. Use `subagent_close` after collecting a child you no longer need: idle children still consume capacity.

## Models and role defaults

Pass the resolver's exact `provider/model:thinking` as `model`. Without the resolver, match the default hint to `subagent_catalog.models`; ignore a speed suffix and use the closest offered thinking level at or below the hint. For inheritance use your exact catalog identity.

## Isolation

Pass `worktree: true` to `subagent_spawn` for a new branch from the commit at `cwd`, or `worktree: {base, branch}` for another base. The checkout under `.pi/worktrees/` survives `subagent_close`; integration and cleanup stay with the parent. For cleanup, cross-check each candidate against the working directories in `subagent_list`, including idle children.

## Nesting

At the root check `subagent_catalog.maxDepth > 1`; as a child check `delegation.childrenMayDelegate` for the child you are composing. Give an authorized coordinator the catalog, spawn, wait, read and close tools; a spawn that grants `subagent_spawn` without wait and read is refused. Otherwise keep the coordinating skill in the parent and delegate only its leaves.

## Store

Give writers the absolute path to their report in the run store. Collect report-only results from the child instead.

## Wake and loop

When `subagent_catalog` reports `features.loops`, start a bounded `subagent_loop` within its interval and duration limits. Put the check and stop condition in the task; stop the loop when either its goal or deadline is reached. For an event, or without loops, delegate a watcher with a deadline; its result wakes the root.

## Ask the human

For credentials, ask the user to authenticate outside the conversation and resume once access works.

## Todo

Use `todo` when exposed.

## Fetch official docs

Discover Context7's `resolve_library_id` and `query_docs` when configured. For a known URL fetch with `curl -fsSL` and extract the relevant section; otherwise locate it with `web_search`. Stop retrying a blocked search.

## Read and search

Use `read`, `grep`, `find`, `ls` or `bash`, as available.

## Drive the app

Use `bash` for a CLI or TUI, a configured browser driver for web UI, or `computer_use` for a supported app. For a logic prototype load the actual local HTML file if the driver permits it; for UI variants open the route on the prototype worktree's dev server.

## Visuals

Write the artifact and give the user its path.

## Pull requests

Use the active forge CLI to check the PR. For an authorized babysit, run the forge watcher per **Wake and loop**. Rearm after a verdict or push if the watcher has exited and the stop condition has not been met.

## Session history

Read the child's `sessionFile` from `subagent_list`, not the parent's session directory.

## Author a skill

When the pi-packages checkout is available, run `node scripts/lint-skill/lint-skill.mjs <skill-directory>` from its root.

## Run a workflow

When `subagent_catalog` reports `features.workflows`, fill the matching template per the README beside the templates, `../p3stack-mode/workflows/README.md` from this skill's directory. From the consumer checkout, substitute the absolute installed poteto-mode directory in `node "<poteto-mode-dir>/../p3stack-mode/scripts/workflow-template.mjs" <absolute-template-path> --list`. Use the same absolute helper to fill the template with `--set` and `--out`.

Review the filled tasks, commands and limits before passing the JSON `path` to `subagent_workflow_start`. Completion wakes the parent. Inspect with `subagent_workflow_inspect`; use `subagent_workflow_control` to pause, resume or cancel. Inspect side effects before retrying interrupted work.
