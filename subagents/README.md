# subagents

Persistent Pi RPC children, composed by the parent from a user-controlled allowlist. No agent profiles: independently choose an allowed model/thinking combination, tools, resources and system-prompt instructions for each task.

## Install

```bash
pi install ./subagents
```

Reload the parent manually or with `self_reload`. Tested with Pi 0.85.1 and Node 22+. TUI and RPC parents are supported.

## Bundled setup and model-selection skill

Installation also exposes `/skill:subagents` (unless skills are filtered out in your Pi package settings). Use it to choose policy scope, configure providers/models/tools/resources, and operate persistent children. The [skill](skills/subagents/SKILL.md) includes [complete example policies](skills/subagents/reference/configuration.md) and a [model-research process](skills/subagents/reference/model-research.md): triangulate Artificial Analysis, Datacurve DeepSWE and CursorBench, then refine the initial hypothesis through trials of the actual deployment. It distinguishes evidence from inference, covers local quantization/runtime differences, and avoids turning incomparable leaderboard scores into a fake universal ranking.

This is parent-side guidance, not automatic configuration or child resource inheritance. It does not overwrite user policies or grant permissions. Example model IDs are placeholders and must be replaced with exact available Pi identities.

## Allowlist: `subagents.json`

The highest-priority existing configuration wins, as a **whole-file replacement**:

1. `<launch cwd>/.pi/subagents.json`, only for a trusted project.
2. `<Pi agent directory>/subagents.json` (normally `~/.pi/agent/subagents.json`).
3. Built-in configuration shipped in `src/policy.ts`.

No merging or upward directory search. Reload Pi to pick up configuration edits. Resource/model availability is rechecked on catalog requests, spawn and resume. An invalid selected file disables new spawning/resumption instead of falling back to broader defaults. Listing, reading, aborting and closing tracked children remain available. Untrusted project configuration is ignored with a user-facing diagnostic.

The built-in policy is equivalent to the following (model descriptions abbreviated):

```json
{
  "version": 1,
  "models": [
    {
      "id": "openai-codex/gpt-5.6-luna:medium",
      "description": "General summarization and exploration."
    },
    {
      "id": "openai-codex/gpt-5.6-luna:xhigh",
      "description": "Basic code implementation and harder reasoning tasks."
    }
  ],
  "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "extensions": [],
  "skills": [],
  "promptTemplates": [],
  "themes": [],
  "systemPrompt": true,
  "appendSystemPrompt": true,
  "contextFiles": true,
  "maxChildren": 4,
  "workingDirectories": ["."]
}
```

### Field semantics

- `version: 1` and `models` are required. Model entries contain an exact `provider/model:thinking` ID and optional descriptive guidance. No fuzzy matches, implicit thinking-level changes or fallback models. Model IDs containing slashes or colons work; the final colon separates the thinking level.
- `tools` permits names, not shell commands. Recursive `subagent_*` tools are always filtered and diagnosed, even if declared. Built-in tools are known directly; extension tools must currently be discoverable in the parent's tool registry to be offered. Selected tools are also checked in the actual child before its task starts. A resource containing a tool does not independently grant permission to that tool.
- `extensions`, `skills`, `promptTemplates`, `themes` permit **explicit local resource files**, using Pi's CLI resource categories. Relative paths resolve against the configuration file's directory; `~/` is supported. For a skill, specify its `SKILL.md`. Directories, wildcards, remote package URLs and implicit resource discovery are intentionally not accepted in this iteration. Installed package resource files can be named explicitly.
- `systemPrompt` and `appendSystemPrompt` permit freely composed text for the corresponding CLI flags. Omit both spawn fields to use Pi's normal default/`SYSTEM.md`; supply `appendSystemPrompt` to augment it, or `systemPrompt` to replace it. Both may be supplied, matching CLI semantics. Pi may interpret an existing file path as prompt-file input, as it does on its CLI.
- `contextFiles` permits normal `AGENTS.md`/`CLAUDE.md` context discovery. It does not replace system-prompt handling. Children can opt out even when permitted. The resolved choice is saved for resume validation.
- `workingDirectories` permits directory roots and their descendants. Relative roots resolve against the parent launch cwd, **not** the configuration directory. Real paths are checked so symlink traversal cannot escape an allowed root. The default is `["."]`.
- `maxChildren` is the live-process cap, including idle children, from 1 to 64 (default 4). The previous `PI_SUBAGENTS_MAX_CHILDREN` override is no longer used.
- In user files, omitted tools/resources mean empty allowlists and omitted permission booleans mean `false`. They do not inherit built-in permissions. Unknown configuration fields are errors.

No user configuration files are generated or overwritten automatically.

### Effective catalog and diagnostics

`subagent_catalog` exposes only usable options: allowed exact models with configured authentication and supported thinking levels, their guidance, modalities, context/output limits and registry pricing; locally known tools; existing resource files; prompt permissions; and allowed directories. Descriptions are user guidance, not measured model benchmarks. Registry prices may not reflect subscription billing or your actual provider bill.

Built-in selection guidance recommends **medium** for exploration, summarization, factual lookup and small bounded investigations; escalate multi-step debugging and implementation decisions to **xhigh**. Prefer xhigh for scoped implementation, regression analysis and interacting constraints—not simple extraction. Both require evidence and verification; higher thinking does not guarantee correctness. The catalog includes this guidance directly, so the parent need not infer it from the model names. Custom policies can supply their own descriptions.

Unavailable entries are omitted, never silently substituted. Their names/reasons are shown to the **user** through `/subagents diagnostics`; the model-facing catalog contains only an omitted-entry count. If no model is usable, spawning is disabled until configuration/availability is fixed.

Configured credentials do not guarantee a successful request: expired authentication, provider outages, remote entitlement problems, and resource load errors can still surface at launch/use. Custom provider models must also be configured in the child environment or supplied by an explicitly selected extension. The child must resolve the exact requested model/thinking selection; fallback is rejected before sending the task.

## Tools

| Tool | Purpose |
|---|---|
| `subagent_catalog` | Discover allowed, currently usable ingredients |
| `subagent_spawn` | Compose and start a child; returns prompt acceptance, not completion |
| `subagent_list` | `{ totals, agents }`: aggregate reported cost/live counts plus child status, unread counts, usage and paths |
| `subagent_send` | Prompt an idle child, or explicitly steer/queue a follow-up for a working child |
| `subagent_read` | Read new output or replay from a cursor |
| `subagent_wait` | Wait for any/all selected children, at most 60 seconds per call |
| `subagent_abort` | Clear queues and cancel work, keeping the child alive |
| `subagent_close` | Abort and stop a child, dismissing pending notifications but retaining readable results and conversation |
| `subagent_resume` | Revalidate a stopped child's saved composition, restart and optionally prompt it |
| `subagent_respond` | Answer a pending extension dialog; human-required approvals remain human decisions |

Example composition, after consulting the catalog:

```json
{
  "name": "reviewer",
  "task": "Review src/auth.ts for correctness. Do not edit. Report file/line references.",
  "cwd": "/absolute/path/to/project",
  "model": "openai-codex/gpt-5.6-luna:medium",
  "tools": ["read", "grep", "find", "ls"],
  "appendSystemPrompt": "Concentrate on authentication correctness and regression risks."
}
```

`tools` is required; `[]` disables tools. Resource arrays are optional and empty by default. There are **no executable, raw CLI argument, environment, separate thinking-level or resource-discovery overrides** in the parent-facing spawn tool. The manager compiles validated selections into CLI arguments. It always loads its own child guard, regardless of configuration.

All normal extension, skill, prompt-template and theme discovery is disabled; only explicitly selected resources load. Context files and normal system prompts follow their own permitted settings. Parent project trust is propagated only within that project's directory tree; child directories outside it do not automatically inherit trust. Children still use normal Pi global settings and credentials, so this is a spawn-composition boundary rather than a hermetic configuration or sandbox.

A completed child remains idle. Use `subagent_send` for discussion or another assignment. On a working child, specify `behavior: "steer"` or `"followUp"`; steering is delivered at a tool boundary, while `subagent_abort` cancels current work. Cancelling `subagent_wait` does not stop children. Wait returns early for pending extension dialogs.

Abort intent is scoped to the current run and recorded before cancellation requests are sent. Native `stopReason: "aborted"` and cancellation-shaped `stopReason: "error"` responses to an explicit abort produce an idle, reusable child with `aborted: true`, not a failure. Unrelated provider errors remain failures even when racing an abort. A later run resets cancellation state. Wait for abort acknowledgement before sending another task. Closing archives a genuine current error as `lastError`; detailed history remains readable, while `error` no longer suggests an unresolved failure on a stopped child.

### Listing, unread counts and cost

`subagent_list` returns an **object**, `{ totals, agents }`, rather than the previous bare array. Totals cover actual tracked attempts, including stopped children and launch failures:

- `tracked`, `live` (attached processes, including idle), `active` (starting/working/waiting for input), and `unreadReports`.
- `reportedCost`: summed latest cumulative Pi-reported session costs, in USD; `missingCost`: sessions without valid cost data. Missing usage is not a claim that the work was free. Snapshots refresh at startup/resume, after assistant/tool-result messages, at turn/compaction completion, and on settle/close, and are not guaranteed provider billing amounts. Resume replaces a child's snapshot rather than adding the same session twice.
- Each child has `unread` (report/error/input/cancellation updates), `unreadAssistant` (assistant output only), and `unreadUpdates` (all updates, including lifecycle/sent echoes). These count retained updates after the default read cursor, not tokens, new runs, or pending notifications. Explicit replay reads and notification delivery do not advance that cursor. An unread result remains readable even after its notification is dismissed by close.

Cap, policy, CLI and directory preflight rejections no longer create child records or diagnostic paths. A real process launch failure remains inspectable. Legacy never-started cap-rejection records are hidden by default; `subagent_list({ "includeRejected": true })` includes them with `rejected: true`, but they remain excluded from totals, footer counts and implicit wait-all selection. Explicit reads by ID still work. Only attached child processes count toward the live cap.

`subagent_read` advances a persistent cursor unless `since` is supplied. Either kind of read acknowledges the updates actually returned, cancelling their pending notifications; a partial page does not acknowledge omitted updates. Returned extension UI requests are acknowledged too. If the formatted tool result exceeds its cap and spills to disk, it does not advance the read cursor or acknowledge unseen output. The last 100 updates are retained, each capped at 12,000 characters; a read returns about 24,000 characters and explicitly reports cursor gaps. Tool results are capped at 30KB/1000 lines, with overflow saved to a private result file.

## Non-recursion: invariant, not policy

Managed children receive `PI_SUBAGENT=1`. This extension registers **no management tools or commands** inside such a child. Configured `subagent_*` names are filtered with a diagnostic. A mandatory child guard removes recursive/unselected tools from the active tool set and blocks their execution even after dynamic reactivation. The manager checks the selected tools are actually available before sending the task. Neither project nor global policy can disable this guard.

This does **not** prevent a child with unrestricted bash from invoking Pi itself, nor does it isolate arbitrary code in an explicitly trusted extension. Shell-level blocking and sandboxing remain out of scope.

## Reports and UI

Completion, failure and extension input requests become durable **pending notifications in the manager**, not immediately queued parent messages. Reading an update through `subagent_read` acknowledges it, removing its pending notification—even if that read happens just before the child settles. Acknowledgement is keyed by child ID and update cursor, so reading an earlier result cannot suppress a newer run. `subagent_list` and `subagent_wait` do not acknowledge findings. Explicit `subagent_close` dismisses that child's pending notifications, even if its result was never read. It does not delete or advance the result history. Already-delivered reports cannot be retracted. Parent reload/exit shutdown is different: unread pending notices are preserved for recovery.

While the parent is working, notices stay in the manager. When it settles (or when a notice arrives while it is already idle), a short 100ms batching window collects remaining unread notices into one attributed custom report, with at most eight short summaries per batch. Idle state and pending notices are rechecked immediately before sending. Remaining batches wait for another idle opportunity. A report is marked delivered only when it enters the parent's message history; it is not announced again. Pending notices and read/delivery acknowledgements persist across reloads. Startup reconciles saved report receipts with the registry, and expired/stopped-child dialogs are discarded. Old registries without a pending queue do not synthesize historical notifications.

These reports are delegated work output, **not user instructions or permission grants**. Routine tool chatter stays in logs. Ordinary child questions can be answered with `subagent_send`; extension dialogs use `subagent_read.uiRequests` and `subagent_respond`. Reading raw log/session files through ordinary file tools is not tracked as a notification acknowledgement.

```text
/subagents
/subagents diagnostics
/subagents abort <id>
/subagents close <id>
/subagents close-all
```

`/subagents` lists each child as `id · name · status · provider/model:thinking · N turns · <footer stats>`. The stats are the bottom-left Pi footer line: `↑input ↓output RcacheRead WcacheWrite CH% $cost context%/window (auto)`. Zero token counts and a zero cost are omitted, as in the footer. Context comes from the child's session stats (`12.4%/272k`, or `?/272k` when context is unknown after compaction). `CH` is the latest prompt cache-hit rate, shown only when that snapshot has cache activity. `(auto)` appears only after the child reports auto-compaction. Turns still count assistant responses, including tool-calling responses. Missing turns or cost are labelled unknown; a snapshot that only has a cost still shows `$cost`. Listing refreshes live snapshots first. These are Pi-reported figures, not subscription bills, and `(sub)` is not shown.

The TUI summary is `subagents: active/total • $cost` (three decimal places), lowercase and theme-dim, right-aligned above the model. Active counts starting, working and waiting-for-input children; total counts all tracked children in this parent session, including closed children and actual launch failures, but not preflight rejections. Cost sums the latest cumulative Pi session-stat snapshots, including closed children; resuming a child updates its existing snapshot rather than adding its previous cost again. Snapshots refresh after each assistant/tool-result message and turn/compaction completion, as well as startup/resume, settle and close. Costs therefore update during multi-turn work; an in-progress streaming response is not included until it completes. Missing/unavailable usage contributes zero until reported. These are Pi-reported costs, not guaranteed subscription billing amounts. Narrow terminals get a separate row. `src/footer.ts` decorates the actual `FooterComponent.prototype.render`; it is an isolated process-wide compatibility hook, not a supported Pi decoration API. It preserves stock rendering and restores the original method on shutdown. It assumes the directory/model remain the first two rows; completely custom footers that do not use that class are unaffected. RPC clients receive a normal status entry.

## Persistence, reload, and migration

State lives in `<Pi agent directory>/subagents/<parent-session-id>/`: a registry, saved Pi sessions, and per-child event/stderr logs. Directories are private (0700), manager-written files 0600. Logs may contain sensitive code/task data and are capped at 20 MiB each (the final record may be truncated). There is no automatic retention/deletion policy.

Normal reload/session replacement/exit clears queues, requests abort, then sends SIGTERM with bounded SIGKILL fallback. Saved children are restored as stopped; resumption is explicit and does not replay interrupted tasks. It rechecks the **current policy and current availability** and recompiles the saved composition, not stale raw arguments. Already-running children are not silently reconfigured; normal parent reload stops them. Completed file edits are not rolled back.

**v1 records:** existing unrestricted child records remain visible/readable/closable, but cannot resume through the new tools because they lack a validated composition. Spawn a new allowlisted child instead. This deliberately prevents old executable/env/CLI settings bypassing the new policy.

A parent crash/SIGKILL may orphan processes; inspect and stop them before resuming sessions. Concurrent parent processes using the same parent session/registry are unsupported. Background daemons deliberately created by children are not guaranteed to be cleaned up.

## Future directions

The [roadmap](ROADMAP.md) records deferred ideas for inter-subagent communication, higher-level workflows and optional sandboxing, along with open design questions and constraints. These are exploratory directions, not implemented features or release commitments.

## Development

```bash
cd subagents
npm ci --ignore-scripts
npm run check
npm test
```

Tests include policy precedence/trust, fail-closed parsing, model/resource filtering, prompt compilation, symlink boundaries, non-recursion, schema escape-hatch removal, lifecycle/cancellation/recovery, notification batching/read acknowledgements/explicit-close dismissal/reload recovery, reported-cost totals and report-only unread counts, preflight rejection without phantom records, both native-abort and Codex-shaped error-abort events with genuine-failure race coverage, and real Pi RPC policy enforcement using a deterministic local provider. End-to-end parent/child RPC tests verify that reading suppresses notifications and unread results trigger exactly one acknowledged report. No real credentials or provider calls are needed for automated tests.
