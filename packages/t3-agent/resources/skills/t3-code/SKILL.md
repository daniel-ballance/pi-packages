---
name: t3-code
description: Map a job to the T3 Code tool that does it. Use under T3 when a task needs a child agent, another thread, a worktree, a pull request watch, a schedule, a secret, a browser or device preview, an inline chart, or a T3 project.
---

T3 tools are named `mcp__t3-code__<name>`. `/t3-agent status` lists the tools declared in Pi's active loadout. Load any other one with `tool_search`, querying its job ("schedule", "preview tab"). In a codemode script call it as `tools.mcp__t3_code__<name>(args)`, which batches independent T3 calls (reading several threads, closing several tabs) in one step. Each tool's own description holds its argument rules; read it before the first call.

Use the structured result in scripts when supplied. Copy ids (`taskId`, `scheduledTaskId`, `tabId`) verbatim, and name a thread in your reply by its `link`, verbatim. To retry a lost create call, reuse its `clientRequestId`; new work gets a new one.

## Jobs

| Job | Tools |
| --- | --- |
| Run a child agent, any provider, your own included | `orchestrator_capabilities` once, then `delegate_task`; `task_status`, `task_cancel` |
| Give a child its own checkout or PR | `delegate_task` with `isolation:"worktree"` (starts from your last commit; commit first) |
| Start an independent top-level thread | `t3_thread_launch` (one, own worktree via `workspaceStrategy`), `create_threads` (several, this checkout) |
| Read, message or wait on another thread | `t3_thread_read`, `t3_thread_send`, `t3_thread_wait`, `t3_thread_search`, `t3_thread_list` |
| Manage a thread | `t3_thread_update` (rename), `t3_thread_configure` (model), `t3_thread_organize` (pin, snooze, settle, archive), `t3_thread_transfer` (fork, merge back), `t3_queue`, `t3_pending_request`, `t3_thread_interrupt` (top-level runs only) |
| Move this thread to a new worktree | `t3_worktree_status` first, then `t3_worktree_handoff` as the turn's last call, with a `continuationPrompt` |
| Track a pull request | `link_pull_request(s)` to show it; `watch_pull_request` to be woken on checks, reviews and conflicts; `unwatch_pull_request`; `write_pull_request_guides` and `read_pull_request_guide` for a reviewer's tour |
| Act later or on a timer | `schedule_task` (`schedule` is an object: `{type:"interval",everyMs}`, `{type:"fixed_time",timeOfDay,weekdays}` or `{type:"webhook"}`), `list_scheduled_tasks`, `run_scheduled_task_now`, `delete_scheduled_task` |
| Get a password, token or login from the user | `request_secret`; use its `secretRef` or the file it delivers, never the value in chat |
| Show a chart, diagram or mockup | `html_preview` to check it, then `html_render`; a PNG file when the user will post it elsewhere |
| Drive a web page or dev server | `preview_open` (`target:{kind:"environment-port",port}` for a dev server), `preview_snapshot`, `preview_act`, `preview_wait_for`, `preview_evaluate`, `preview_navigate`, `preview_resize`, `preview_set_appearance`, `preview_dialog`, `preview_recording_start` and `_stop`; `t3_preview_list`; `t3_preview_close` when done |
| Drive an iOS Simulator or Android Emulator | `device_list`, `device_open` (returns the `agent-device` command to drive it), `device_screenshot`, `device_close` |
| Send a file into a thread | `t3_attachment_prepare_upload`, POST the bytes, then `t3_thread_send_attachments`; `t3_attachment_discard` |
| Work with projects and machines | `t3_project_list`, `_read`, `_create`, `_update`, `_delete`, `_clone`; `t3_environment_read`; `t3_environment_links` and `t3_environment_link` for another machine |

`t3_background_wait` and `t3_workflow_stop` serve Claude threads only; Pi has no use for them.

## Pi under T3

- Pi has no native subagent tool here. `delegate_task` is the subagent tool for every child. A review round, a re-check or a fix after review is a new `delegate_task` carrying the brief and the findings.
- The permission mode caps every thread or child you create: a target never runs with broader modes than yours.
- After `watch_pull_request`, `delegate_task` with `mode:"async"`, or `schedule_task`, end the turn; T3 wakes this thread. The watch stays on across wakes, so a wake is not a cue to watch again.
- t3-agent records the delegates, schedules, watched pull requests, preview tabs, devices and threads you create in the `t3_agent` section, so their ids survive compaction. `/t3-agent ledger` lists them; `/t3-agent forget <id>` drops a stale one without touching T3.
