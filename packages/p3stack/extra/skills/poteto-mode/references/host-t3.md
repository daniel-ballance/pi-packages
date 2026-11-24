# T3 Code capabilities

Use the live tool descriptions for arguments and results. Tools can load late; search by name before declaring one absent.

## Delegate

Pi delegates with `mcp__t3-code__delegate_task`. The child gets only the task. T3 has no fixed live-child limit; start large fan-outs a few at a time. Reuse a `clientRequestId` only to retry the same lost call. For a report-only review or research brief, set the corresponding `role` and say not to edit; there is no per-task tool subset. Use `mode: "wait"` when this turn needs the result; otherwise dispatch asynchronously. Follow the response's `next`; a timeout is not completion. While work is running, do other authorized work or end your turn. Never poll; read `mcp__t3-code__task_status` on completion wake. Stop unwanted tasks with `mcp__t3-code__task_cancel`.

With p3stack on, start `task` with the resolver's `briefHeaders.report` for review or research, `briefHeaders.work` otherwise. Add a blank line, then the assignment. For a task-specific grant, replace the header's `Grant:` line with `Task grant: default` or `Task grant: full-autonomy`. Send the complete text for approval. The approval dialog shows the first 4,000 characters of the call, so state the scope and anything the human must agree to first.

## Models and role defaults

Pass the `p3stack_roles` target unchanged. Omit `target` for a returned `null` (inherit), not for a missing role. The resolver consults `mcp__t3-code__orchestrator_capabilities`; without the resolver, consult it before the first delegation. For a user-named model missing from the short list, search that catalog before reporting it unavailable. Never replace it.

## Isolation

Set `isolation: "worktree"` to start a child at the parent's commit. If that cannot express the required base, report the mismatch; never put a checkout command in the brief or create the child's checkout in the shell. For cleanup, check the project's thread worktrees with `mcp__t3-code__t3_thread_list`, including delegates (`includeSubagents: true`).

## Nesting

A child does the work itself unless its assignment explicitly authorizes delegation. Report-only children do not delegate.

## Store

Inline what the child needs or cite the commit and repo-relative path. Give an absolute path only into the run store and only to a child on this machine; otherwise collect evidence in the task result.

## Wake and loop

For a playbook heartbeat, schedule only a standing run the user authorized; otherwise use delegates' completion wakes. Use `mcp__t3-code__schedule_task` for a requested schedule without running it now. Remove it with `mcp__t3-code__delete_scheduled_task` at the stop condition. For PR activity use **Pull requests**.

## Ask the human

For a credential only the user can supply, open `mcp__t3-code__request_secret` instead of asking in chat. If unavailable, stop at the credential gate.

## Todo

Use `todo` when exposed.

## Fetch official docs

Look up Context7 with `tool_search` when configured, or fetch the official page. If the current request asks for work in the browser, use **Drive the app** for that page instead.

## Read and search

Use Pi's `read` and search tools or `bash` in the bound checkout.

## Drive the app

Use `mcp__t3-code__preview_snapshot` and `mcp__t3-code__preview_act` only when the current request asks for browser work. Otherwise use the project's own harness or test driver; report a surface you cannot exercise as unverified. Close only tabs you opened and the user is not using or asking to keep.

## Visuals

For an inline visual use `mcp__t3-code__html_preview` then `mcp__t3-code__html_render`. For an image to use elsewhere, give the PNG path instead.

## Pull requests

Use `mcp__t3-code__list_thread_pull_requests` only when you need the linked PR list. Link a created PR with `mcp__t3-code__link_pull_request`. For an authorized babysit where both watch tools exist, use `mcp__t3-code__watch_pull_request` instead; it links the PR and stays armed across wakes. Stop that watch with `mcp__t3-code__unwatch_pull_request` at the agreed end. Otherwise give the owner the PR and current forge status; do not promise wakes.

## Session history

Use the delegate's `childThreadId`, not its `taskId`. If unknown, use `mcp__t3-code__t3_thread_list` for this project with `includeSubagents` and confirm `parentThreadId` before reading. `mcp__t3-code__t3_thread_search` skips child threads. Read the in-scope thread with `mcp__t3-code__t3_thread_read`.

## Author a skill

Run the repository's `lint-skill` in the bound checkout when available.

## Run a workflow

Follow the prose procedure, delegating authorized units per **Delegate**. T3 does not run the workflow templates.
