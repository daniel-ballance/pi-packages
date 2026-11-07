# p3stack under T3 Code

This is the maintainer reference for how T3 Code hosts Pi and which T3 behavior p3stack depends on. The agent-facing rules live in the [host map](../extra/skills/poteto-mode/references/host-capabilities.md). The reviewed T3 release and commit are `reviewed` in [`rules/t3-pin.json`](../rules/t3-pin.json). T3 paths below are relative to the [T3 repository](https://github.com/pingdotgg/t3code). Citations name a symbol rather than a line, because lines move between releases.

## How T3 hosts Pi

T3 runs one `pi --mode rpc` process per thread and drives it with JSON lines over stdio. `buildPiRpcLaunch` in `packages/provider-pi/src/server/mcpInjection.ts` sets `T3_MCP_URL`, `T3_MCP_BEARER_TOKEN`, `T3_PI_MCP_EXTENSION_PATH` and `T3_PI_RUNTIME_MODE` for that session only. It passes T3's bridge extension with `--extension`. The user's Pi packages load as usual, so p3stack loads too. [`shared/host.ts`](../../../shared/host.ts) reports the T3 host when `T3_MCP_URL` is set.

The bridge is generated from `packages/provider-pi/src/server/mcpExtensionSource.ts` and written to `~/.t3/caches/pi-t3-mcp-extension.ts`. It is an MCP client for T3's server. It registers every T3 tool as `mcp__t3-code__<name>`. Only `orchestrator_capabilities`, `delegate_task` and `task_status` are direct. The rest are deferred behind Pi's builtin `tool_search`, and become direct when that builtin is missing or replaced.

Pi does not enforce T3's permission modes. The bridge's `tool_call` hook does. Full access allows every call. Every mode allows `read`, `grep`, `find`, `ls`, `tool_search` and T3 tools marked read-only. Auto-accept-edits also allows `edit` and `write`. Any other call goes to `ctx.ui.confirm`, which T3 shows as an approval card. T3 writes Pi's `auto` mode as approval-required.

On each `before_agent_start` the bridge sets `sections.t3_code_orchestration` to `T3_CODE_ORCHESTRATION_INSTRUCTIONS` from `packages/provider-core/src/server/orchestrationInstructions.ts`. It returns a `systemPrompt` only when sections are missing or `forceSystemPrompt` is set. p3stack's `p3stack` section sits beside it. The T3 text tells the model to use its native subagent tool for same-provider work. Pi under T3 has no such tool, because the subagents package registers nothing there. `delegate_task` is the only delegation path, and the host map says so.

`delegate_task` creates a child T3 thread. When the child ends, T3 queues a message on the parent, and that message starts the parent's next turn. `delegatedCompletionWakeDetail` in `apps/server/src/orchestration-v2/Orchestrator.ts` writes it. It starts with `Delegated task node:delegated-task:` and inlines results up to 16,000 bytes. A larger result gets a line that says to use `task_status`. `apps/server/src/orchestration-v2/ProviderContinuationService.ts` holds the fallback texts. `task_status` on a finished task acknowledges delivery, and `planDelegatedCompletionDelivery` sends no wake for an acknowledged task. Polling therefore loses the wake. T3 delivers a wake as a user message, so p3stack's mode must recognize it and skip the routing reminder.

Three actors may start agent work. The MCP session that owns the live run is one. Server wakes, scheduled tasks and PR watches are another. The third is Pi itself, but only inside a T3 turn. The adapter in `packages/provider-pi/src/server/adapter.ts` stops the session when Pi starts work outside a turn with no continuation offer.

The adapter maps `ctx.ui` calls as follows. `select`, `confirm`, `input` and `editor` become T3 approval or input requests. `notify` becomes a system notice in the current turn, and the adapter drops it outside one. The adapter also drops `setStatus`, `setWidget`, `setTitle`, `setFooter` and `custom`. `ctx.hasUI` is true under RPC, so terminal chrome checks `ctx.mode === "tui"`.

## What p3stack relies on

`watch` in [`rules/t3-pin.json`](../rules/t3-pin.json) lists each T3 file p3stack depends on. Each entry names the contract p3stack relies on and its dependents, which include the tests that pin it. `node packages/p3stack/generator/check-t3-pin.mjs --source <checkout> --ref <tag>` prints the entries whose T3 file changed since `reviewed.commit`. Entries with no test dependent, such as the orchestration instructions and the pull-request tools, are checked only by reading the diff during a release review.

## Known gaps

- claude-subscription's `claude_code` tool is a third delegation path. Nothing demotes it under T3 and the host map does not name it. T3 cannot see or cancel work delegated through it.
- Read-only briefs under T3 key on `role`. A `research` or `review` child gets the reader recipe. A child described as read-only but given another role gets the full agent recipe, because T3 has no per-child tool subset.
- T3 shows no p3stack mode indicator and no todo list. The footer and widget are terminal only. Under T3 the signs of the mode are the notice when it is toggled and the model's routing. The todo list reaches T3 only as tool result text.
- Plan-mode text may not reach Pi. The adapter accepts no system context and T3 hides the interaction-mode toggle for Pi. Nobody has traced T3's plan-mode path for Pi.
- `self_reload` works under T3. Verified on 2026-10-30 against T3 v0.1.3-nightly.20261026.3717 in a delegated full-access Pi child. T3 showed the reload notice and adopted the post-reload continuation as a new run. A delegated child that reloads wakes its parent twice. The first wake carries the pre-reload reply. The second carries the post-reload reply, under a task id that starts `node:delegated-task:provider-continuation`.

## Review a T3 release

Follow **Review a T3 release** in [`maintain-p3stack`](../authored/skills/maintain-p3stack/SKILL.md). It checks out the installed release, runs the `--source` checker, reviews each changed contract the checker prints, refreshes the catalog fixture and moves `reviewed`.
