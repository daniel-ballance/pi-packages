# subagents

Persistent Pi RPC children, composed by the parent from a user-controlled allowlist. No agent profiles: independently choose an allowed model/thinking combination, tools, resources and system-prompt instructions for each task.

## Install

```bash
# From the repository root:
npm ci --ignore-scripts
pi install ./packages/subagents
```

Reload the parent manually or with `self_reload`. Requires Pi 0.99.2 or newer; tested with its Node CLI and the installed bundled executable on Linux (Node 22+ for development). TUI and RPC parents are supported.

## Disable native startup for one launch

`--disable-native-subagents` opts out of this package for that Pi launch,
including reloads. Pi parses extension flags after loading factories, so native
registration/startup is deferred until `session_start`. With the flag, no
`subagent_*` tools, `/subagents` or `/workflows` commands, Manager, workflow
runner, footer decoration or notification scheduler is initialized. Unrelated
extensions and skill discovery are unchanged. Normal unflagged TUI/RPC launches
retain the existing behavior; marked native Children still register nothing.

Use this with the separate [t3-subagents](../t3-subagents/README.md) extension
when T3 owns delegated execution and parent wake-ups. It is an opt-out, not an
automatic environment-based policy change, and does not edit `subagents.json`.

## Bundled setup and model-selection skill

Installation also exposes `/skill:subagents` (unless skills are filtered out in your Pi package settings). Use it to choose policy scope, configure providers/models/tools/resources, and operate persistent children. The [skill](skills/subagents/SKILL.md) includes [complete example policies](skills/subagents/reference/configuration.md) and a [model-research process](skills/subagents/reference/model-research.md): triangulate Artificial Analysis, Datacurve DeepSWE and CursorBench, then refine the initial hypothesis through trials of the actual deployment. It distinguishes evidence from inference, covers local quantization/runtime differences, and avoids turning incomparable leaderboard scores into a fake universal ranking.

This is parent-side guidance, not automatic configuration or child resource inheritance. It does not overwrite user policies or grant permissions. Example model IDs are placeholders and must be replaced with exact available Pi identities.

## Workflows

The bundled `/skill:workflows` helps the parent author and supervise JSON workflows using the same manager: task DAGs with explicit fan-out/all-input fan-in, command/agent/human checks, bounded repair and improvement loops, and optional peer task groups. The runtime schedules authorized work without manual parent relaying, retains artifact/validation history, and reports completion or exceptions rather than routine worker chatter.

See [WORKFLOWS.md](WORKFLOWS.md) for the contract, examples, observability, limits and explicit recovery. Start/inspect/control tools are `subagent_workflow_start`, `subagent_workflow_inspect`, `subagent_workflow_control`; `/workflows` is the human interface. These remain parent-only under the existing non-recursion guard. No new daemon or workflow permission schema: workers use current subagent policy; deterministic commands additionally require its `bash` permission. Each run explicitly sets concurrency, total attempts and a wall-clock deadline. Candidate paths/digest checks are not an OS sandbox.

## Allowlist: `subagents.json`

The highest-priority existing configuration wins, as a **whole-file replacement**:

1. `<launch cwd>/.pi/subagents.json`, only for a trusted project.
2. `<Pi agent directory>/subagents.json` (normally `~/.pi/agent/subagents.json`).
3. Built-in configuration shipped in `extensions/subagents/src/policy.ts`.

No merging or upward directory search. Reload Pi to pick up configuration edits. Resource/model availability is rechecked on catalog requests, spawn and resume. An invalid selected file disables new spawning/resumption instead of falling back to broader defaults. Listing, reading, aborting and closing tracked children remain available. Untrusted project configuration is ignored with a user-facing diagnostic.

The built-in policy is equivalent to the following (model descriptions abbreviated):

```json
{
  "version": 1,
  "models": [
    {
      "id": "openai-codex/gpt-6-luna:medium",
      "description": "Cheap ChatGPT-pool exploration and grounded summaries."
    },
    {
      "id": "openai-codex/gpt-6-luna:max",
      "description": "Stronger budget reasoning and scoped implementation."
    },
    {
      "id": "openai-codex/gpt-6-sol:high",
      "description": "Substantive ChatGPT-pool implementation and debugging."
    },
    {
      "id": "openai-codex/gpt-6-sol:max",
      "description": "Upper ChatGPT-pool subagent escalation."
    },
    {
      "id": "xai/grok-4.6:low",
      "description": "Economical Grok-pool investigation and second opinions."
    },
    {
      "id": "xai/grok-4.6:high",
      "description": "Demanding Grok-pool implementation and review."
    },
    {
      "id": "xai/grok-4.7:high",
      "description": "Upper Grok-pool subagent escalation."
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
  "peerMessageLimit": 0,
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
- `peerMessageLimit` is an integer from 0 to 1000, default **0 (disabled)** in both built-in and user policies. A positive value caps each directional peer-message allowance. Also allowlist `peer_send` and explicitly select it in each participating child's `tools`. No existing policy gains communication implicitly. This limits message-triggered turns, not tokens or provider costs.
- `maxChildren` is the live-process cap, including idle children, from 1 to 64 (default 4). The previous `PI_SUBAGENTS_MAX_CHILDREN` override is no longer used.
- In user files, omitted tools/resources mean empty allowlists and omitted permission booleans mean `false`. They do not inherit built-in permissions. Unknown configuration fields are errors.

No user configuration files are generated or overwritten automatically.

### Effective catalog and diagnostics

`subagent_catalog` exposes only usable options: allowed exact models with configured authentication and supported thinking levels, their guidance, modalities, context/output limits and registry pricing; locally known tools; existing resource files; prompt permissions; and allowed directories. Descriptions are user guidance, not measured model benchmarks. Registry prices may not reflect subscription billing or your actual provider bill.

Built-in selection guidance offers two provisional menus: **GPT-6 Luna medium → Luna max → Sol high → Sol max** in the ChatGPT pool, and **Grok 4.6 low → 4.6 high → 4.7 high** in the Grok pool. These are starting-tier choices, not mandatory retry chains. Prefer the OpenAI options for benchmark-derived global value when both pools are healthy; choose suitable Grok options when conserving the separate ChatGPT allowance, especially for the parent. No live quota detection or automatic routing is implied. Astra is deliberately absent from the subagent defaults; return persistent blockers to the parent.

This is benchmark-informed guidance, not demonstrated Pi task performance. Require grounded evidence, tests and review; refine descriptions from accepted outcomes. Higher thinking is not a correctness guarantee. The catalog includes each entry's guidance directly. Custom policies can supply their own descriptions; detailed evidence stays outside policy.

Unavailable entries are omitted, never silently substituted. Their names/reasons are shown to the **user** through `/subagents diagnostics`; the model-facing catalog contains only an omitted-entry count. If no model is usable, spawning is disabled until configuration/availability is fixed.

Configured credentials do not guarantee a successful request: expired authentication, provider outages, remote entitlement problems, and resource load errors can still surface at launch/use. Custom provider models must also be configured in the child environment or supplied by an explicitly selected extension. The child must resolve the exact requested model/thinking selection; fallback is rejected before sending the task.

## Managed built-in extensions

Pi 0.99.2 supplies the client and executors: this package adds policy checks, not another MCP client. Select exact `builtin:codemode`, `builtin:tool-search`, or `builtin:mcp` identifiers from the catalog. Existing policies gain nothing implicitly; unknown built-ins and `builtin:llama.cpp` are rejected. Codemode classifiers and virtual model selection are not supported.

See [built-in grants and settings](skills/subagents/reference/builtins.md) for the exact fields, credential consent, configuration eligibility, limitations and minimal migration snippets. The legacy `mcp-client` package remains unchanged and is not needed for this integration.

## Tools

| Tool | Purpose |
|---|---|
| `subagent_catalog` | Discover allowed, currently usable ingredients |
| `subagent_spawn` | Compose and start a child; returns prompt acceptance, not completion |
| `subagent_list` | `{ totals, agents }`: aggregate reported cost/live counts plus child status, unread counts, usage and paths |
| `subagent_send` | Prompt an idle child, or explicitly steer/queue a follow-up for a working child; returns the observed input `disposition` |
| `subagent_connect` | Parent authorizes a bidirectional peer link with independent directional allowances |
| `subagent_disconnect` | Disable a link without erasing counters/history or stopping children |
| `subagent_renew` | Parent explicitly replenishes one direction's allowance |
| `subagent_peers` | Inspect links/counters and paginated peer-message history |
| `subagent_read` | Read new output or replay from a cursor |
| `subagent_wait` | Wait for any/all selected children, at most 60 seconds; optional `collect:true` returns bounded new report pages |
| `subagent_abort` | Clear queues and cancel work, keeping the child alive |
| `subagent_close` | Abort and stop a child, dismissing pending notifications but retaining readable results and conversation |
| `subagent_release_hold` | After discussing a human intervention, release a child or workflow hold without starting work |
| `subagent_resume` | Revalidate a stopped child's saved composition, restart and optionally prompt it |
| `subagent_respond` | Queue an answer to a pending extension dialog; human-required approvals remain human decisions |
| `subagent_workflow_start` | Start a parent-authored JSON workflow; returns acceptance |
| `subagent_workflow_inspect` | Inspect run/step progress, artifacts, validation and attempts |
| `subagent_workflow_control` | Pause, explicitly resume/retry, or cancel a workflow |

Example composition, after consulting the catalog:

```json
{
  "name": "reviewer",
  "task": "Review src/auth.ts for correctness. Do not edit. Report file/line references.",
  "cwd": "/absolute/path/to/project",
  "model": "openai-codex/gpt-6-luna:medium",
  "tools": ["read", "grep", "find", "ls"],
  "appendSystemPrompt": "Concentrate on authentication correctness and regression risks."
}
```

`tools` is required; `[]` disables tools. Resource arrays are optional and empty by default. Optional `coordination: { owns: ["src/auth.ts"], outputs: ["reports/auth.md"] }` declares work areas and expected outputs. Paths resolve against the child cwd; overlap warnings are advisory, not locks, permissions or a sandbox. They do not create worktrees or merge changes. There are **no executable, raw CLI argument, environment, separate thinking-level or resource-discovery overrides** in the parent-facing spawn tool. The manager compiles validated selections into CLI arguments. It always loads its own child guard, regardless of configuration.

All normal extension, skill, prompt-template and theme discovery is disabled; only explicitly selected resources load. Context files and normal system prompts follow their own permitted settings. Parent project trust is propagated only within that project's directory tree; child directories outside it do not automatically inherit trust. Children still use normal Pi global settings and credentials, so this is a spawn-composition boundary rather than a hermetic configuration or sandbox.

A completed child remains idle. `subagent_list` also provides structured capacity/recovery guidance, identifying idle and held workers without recommending automatic release. Use `subagent_send` for discussion or another assignment. On a working child, specify `behavior: "steer"` or `"followUp"`; steering is delivered at a tool boundary, while `subagent_abort` cancels current work. Cancelling `subagent_wait` does not stop children. Wait returns early for pending extension dialogs. `subagent_respond` removes a pending dialog only after the child stdin write callback succeeds; its result reports transport `queued` and receipt `unconfirmed`, because Pi's extension UI response protocol has no acknowledgement record.

Abort intent is scoped to the current run and recorded before cancellation requests are sent. Native `stopReason: "aborted"` and cancellation-shaped `stopReason: "error"` responses to an explicit abort produce an idle, reusable child with `aborted: true`, not a failure. Unrelated provider errors remain failures even when racing an abort. A later run resets cancellation state. Wait for abort acknowledgement before sending another task. Closing archives a genuine current error as `lastError`; detailed history remains readable, while `error` no longer suggests an unresolved failure on a stopped child.

### Human supervision and assignment state

The human supervises the parent; the parent manages children. `/subagents` is an observational viewer with only two worker interventions: **Halt** (cancel active work and queued prompts, retain process/conversation) and confirmed **Kill** (force-stop the process). In a worker view, `h` requests Halt and `Shift+K` opens target-specific Kill confirmation; Esc remains back/close navigation. Kill remains available to escalate a stuck Halt. Neither operation rolls back edits or guarantees detached subprocess cleanup.

Both persist a human hold before asynchronous cancellation and send attributed requested/outcome supervisory notices to the parent. Halt verifies idle state after cancellation; Kill has a bounded process-close confirmation. Failed Halt can escalate to Kill, and failed Kill can be retried. Unknown prompt acceptance blocks confirmation/release until an observed process exit; after a crash, inspect for orphaned work rather than assuming the absence of an attached process means it stopped. These notices can steer a busy parent; ordinary reads, close, and workflow cleanup cannot dismiss them. Delivery is acknowledged only when the event enters parent history. The parent must acknowledge the intervention and discuss next steps, not automatically replace/retry/resume the stopped work.

Held children reject prompts, peer participation, UI responses and resumption. Owned workflows retain a scheduling barrier against retries, further checks and replacement workers. Holds survive reload. `subagent_release_hold({id})` releases a child hold; for workflows, release every held child and then the workflow ID. Release starts nothing: process resume, prompts and workflow retry/resume are separate explicit operations after discussion. The human viewer has no release, messaging, steering or dialog-answer controls.

Process `status` is separate from `assignment` (identity, task, running/completed/failed/cancelled) and `resultReview` (unreviewed/reviewed by the parent). Idle is not success; completed means settled work, not independently validated correctness. Old records without reliable assignment evidence are not retroactively labelled successful. Reading the final result updates review state; merely browsing the viewer does not.

### Listing, unread counts and cost

`subagent_list` returns an **object**, `{ totals, agents }`, rather than the previous bare array. Totals cover actual tracked attempts, including stopped children and launch failures:

- `tracked`, `live` (attached processes, including idle), `active` (starting/working/waiting for input), and `unreadReports`.
- `reportedCost`: summed latest cumulative Pi-reported session costs, in USD; `missingCost`: sessions without valid cost data. Missing usage is not a claim that the work was free. Snapshots refresh at startup/resume, after assistant/tool-result messages and persisted usage/summary entries (including idle cache warming), at turn/compaction completion, and on settle/close, and are not guaranteed provider billing amounts. Resume replaces a child's snapshot rather than adding the same session twice.
- Each child has `unread` (report/error/input/cancellation updates), `unreadAssistant` (assistant output only), and `unreadUpdates` (all updates, including lifecycle/sent echoes). These count retained updates after the default read cursor, not tokens, new runs, or pending notifications. Explicit replay reads and notification delivery do not advance that cursor. An unread result remains readable even after its notification is dismissed by close.

Cap, policy, CLI and directory preflight rejections no longer create child records or diagnostic paths. A real process launch failure remains inspectable. Legacy never-started cap-rejection records are hidden by default; `subagent_list({ "includeRejected": true })` includes them with `rejected: true`, but they remain excluded from totals, footer counts and implicit wait-all selection. Explicit reads by ID still work. Only attached child processes count toward the live cap.

`subagent_wait({collect:true})` peeks at bounded contiguous report pages, returning `reports`, `deferred` IDs and `hasMoreReports` alongside wait state. Only pages successfully returned without tool-result overflow are acknowledged; deferred output remains unread. Use `subagent_read` for a specific child or oversized page. Ordinary wait remains non-acknowledging.

`subagent_read` advances a persistent cursor unless `since` is supplied. Either kind of read acknowledges the updates actually returned, cancelling their pending notifications; a partial page does not acknowledge omitted updates. Returned extension UI requests are acknowledged too. If the formatted tool result exceeds its cap and spills to disk, it does not advance the read cursor or acknowledge unseen output. The last 100 updates are retained, each capped at 12,000 characters; a read returns about 24,000 characters and explicitly reports cursor gaps. Tool results are capped at 30KB/1000 lines, with overflow saved to a private result file.

## Peer communication

Opt in with `"peerMessageLimit": 10` and add `"peer_send"` to the policy's tool allowlist. Reload, then spawn participating children with `peer_send` explicitly selected. This tool is provided by the mandatory guard; no extra extension/resource is required. Children without it cannot participate. The parent does not receive `peer_send`.

After spawning A, B and C, authorize only B↔C:

```text
subagent_connect({ a: B_ID, b: C_ID, limit: 3 })
```

Tell B and C their peer IDs using ordinary parent prompts, or opt into `introduce:true` on connect. Introductions send each peer's identity and current assignment, can start new billable turns, and report acceptance/errors per recipient. They do not consume peer allowances or retry automatically; on uncertain acceptance inspect before retrying. Each may now call `peer_send({ recipient: OTHER_ID, message: "findings or question" })`. B can send C three messages and C can independently send B three. A cannot send to or receive from either. Links are not transitive. No channel, broadcast or polling inbox is implied.

The manager binds sender identity to a private inherited process pipe. Message text cannot supply a different sender or call parent management tools. Recipients receive manager-attributed peer work output, **not user instructions, permissions or human approvals**. A leading slash in the body is escaped inside the envelope, never dispatched as a command. Unrestricted bash and trusted extensions still have host access; this is not a sandbox.

Delivery uses RPC `prompt` with `streamingBehavior: "steer"`: working recipients get steering at a tool boundary; idle recipients start a new turn. Pi makes this choice, avoiding an external working→idle race. Starting/stopping/stopped/failed/waiting-for-input recipients and abort-in-progress are rejected. No process is implicitly resumed and no human dialog is answered. Ordinary assistant replies remain parent-visible; replying to a peer requires another explicit `peer_send` call. Existing completion/error/input notifications still apply; peer messages themselves do not generate extra parent notices.

### Allowances and delivery state

- Every send reserves a slot **before** asynchronous submission. Concurrent calls cannot overspend. The result includes a stable message ID and remaining allowance.
- Definitive RPC rejection refunds the slot (`rejected`). Timeout/transport failure retains it (`unknown`); ask the parent to inspect before retrying. No automatic replay or retry.
- Send results expose `disposition`: `started`, `queued`, `handled`, or `unknown` when an older runtime does not report it. `handled` means an extension consumed the input; it is not a completed assignment. The latest submission is retained on the child record. Workflow task inputs consumed this way fail the attempt; its submission disposition is recorded.
- Peer `handled` means an extension consumed the envelope without an observed conversation receipt. It retains its allowance and is not automatically retried. A matching observed receipt takes precedence.
- `accepted` means RPC accepted/queued, not completion. `received` means the matching message entered the recipient's conversation, not proof the model read or answered it. Parent history can show `submitting` while a send is in flight.
- Abort/close/reload may discard queued messages. Unconfirmed receipts are marked `interrupted`, retaining their consumed allowance. Already-received history stays received; interrupted messages are never automatically redelivered.
- Disconnect prevents subsequent sends but cannot retract already-submitted ones. Reconnecting with no `limit` preserves both allowances, including exhaustion. Repeating connect is not renewal.
- `subagent_renew({ sender, recipient, limit })` starts a new generation for **one direction**, resetting `used` while retaining lifetime `total`. It requires an enabled link and ready live peers and refuses in-flight sends for that direction. Renewal can cause additional model usage; use deliberately.
- Links, counters and generations survive reload/resume. Current policy ceilings still apply; disabling communication prevents new sends/connections/renewals, not inspection/disconnection.

`subagent_peers({ id?, since? })` shows links and up to five messages per page from the last 200 retained. Follow `nextCursor` while `hasMore`; `gap` reports evicted history. These are message-creation cursors, not status-change cursors: replay a page to refresh statuses. Message bodies are capped at 4000 characters. Counts outlive body eviction. Reading peer history does not acknowledge ordinary child reports. This is bounded audit history, not a durable delivery inbox or an exactly-once messaging guarantee.

See [the design note](PEER-MESSAGING.md) for scope, failure semantics and acceptance tests.

## Non-recursion: invariant, not policy

Managed children receive `PI_SUBAGENT=1`. This extension registers **no management tools or commands** inside such a child. Configured `subagent_*` names are filtered with a diagnostic. A mandatory child guard removes recursive/unselected tools from the active tool set and blocks their execution even after dynamic reactivation. The manager checks the selected tools are actually available before sending the task. Neither project nor global policy can disable this guard.

This does **not** prevent a child with unrestricted bash from invoking Pi itself, nor does it isolate arbitrary code in an explicitly trusted extension. Shell-level blocking and sandboxing remain out of scope.

## Reports and UI

Tool calls use compact, themed TUI summaries instead of raw JSON by default. Rendered chrome and display names are lowercase; task/output text, identifiers, paths and expanded payloads retain their original case. Call rows start with `subagents •` to identify their source (`subagents • catalog`, `subagents • list`); child and workflow actions also retain their target name and parameters.

- **Catalog:** availability, model options, tool names and child limit.
- **Spawn/send/resume/abort/close/respond:** child name, status, ID, model, turns and footer-style usage when available.
- **List/wait:** child summaries and aggregate usage where supplied; timeouts and input requirements remain visible.
- **Read:** the latest assistant reply rather than lifecycle/sent echoes, plus errors, pending input, history gaps and pagination warnings.

Expand tool output (Ctrl+O by default, respecting Pi keybindings) to see the full returned JSON, including paths, policy guidance and all returned updates. Collapsed views bound reply previews and large lists; names and metadata truncate to terminal width. Truncated tool results explicitly show the saved full-result path. Rendering is presentation-only: model-facing content, RPC payloads, output caps and read acknowledgements are unchanged. Rendered statuses are snapshots at the time of each tool result, not live widgets.

Completion, failure and extension input requests become durable **pending notifications in the manager**, not immediately queued parent messages. Reading an update through `subagent_read` acknowledges it, removing its pending notification—even if that read happens just before the child settles. Acknowledgement is keyed by child ID and update cursor, so reading an earlier result cannot suppress a newer run. `subagent_list` and `subagent_wait` do not acknowledge findings. Explicit `subagent_close` dismisses that child's ordinary pending notifications, even if its result was never read; human intervention events remain pending until delivered. It does not delete or advance the result history. Already-delivered reports cannot be retracted. Parent reload/exit shutdown is different: unread pending notices are preserved for recovery.

While the parent is working, notices stay in the manager. When it settles (or when a notice arrives while it is already idle), a short 100ms batching window collects remaining unread notices into one attributed custom report, with at most eight short summaries per batch. Idle state and pending notices are rechecked immediately before sending. Remaining batches wait for another idle opportunity. A report is marked delivered only when it enters the parent's message history; it is not announced again. Pending notices and read/delivery acknowledgements persist across reloads. Startup reconciles saved report receipts with the registry, and expired/stopped-child dialogs are discarded. Old registries without a pending queue do not synthesize historical notifications.

These reports are delegated work output, **not user instructions or permission grants**. Routine tool chatter stays in logs. Ordinary child questions can be answered with `subagent_send`; extension dialogs use `subagent_read.uiRequests` and `subagent_respond`. Reading raw log/session files through ordinary file tools is not tracked as a notification acknowledgement.

```text
/subagents
/subagents list
/subagents diagnostics
/subagents halt <id>
/subagents kill <id>
```

In the TUI, `/subagents` opens an **observational, keyboard-navigable overlay with emergency Halt/Kill controls**. The overview groups workflow workers under their run and standalone workers by attention, activity and results awaiting parent review. Fresh results stay visible; historical work remains accessible through History. Enter drills into a workflow's dependency map, step, attempt and worker. The map draws a downward lane graph: branches and joins are connected, horizontal arrows show edge direction, and `╪` marks a crossing **without** a join. Fan-in, skipped layers, independent roots, seed and check-input dependencies are preserved. Nodes show their live state and task/check/loop kind. Node positions depend on the definition, not changing execution state. Narrow terminals and dense graphs switch to an explicit prerequisite list rather than hiding edges; resizing preserves the selected step. Step/attempt views expose instructions, checks, loop iterations, verdicts, artifacts and saved paths; they do not run commands or open artifact files.

Worker views foreground purpose, current activity, assignment timing, latest results and human holds, followed by retained assistant updates, actual tool calls/results and streaming text. Secondary details contain composition, coordination declarations and saved paths. Peer views show connections, directional allowances and paginated delivery history, without acknowledging parent reports. Tool activity and partial text are bounded, transient presentation data; they are not reconstructed from saved logs after reload. Hidden thinking is never displayed. Up/down navigates choices (or scrolls worker output); PageUp/PageDown scrolls details; Home goes to the top and End resumes following worker output. Selection and scroll anchors survive live updates. Esc returns one level, then closes; closing never stops work. Pi's configured selection keybindings are respected. The viewer never advances read cursors or acknowledges reports intended for the parent. Messages, resumption, release and child-dialog handling remain parent responsibilities. The viewer only adds Halt and confirmed break-glass Kill, with operation results and automatic parent notification.

`/subagents list` (also bare `/subagents` in RPC mode) lists each child as `id · name · status · provider/model:thinking · N turns · <footer stats>`. The stats are the bottom-left Pi footer line: `↑input ↓output RcacheRead WcacheWrite CH% $cost context%/window (auto)`. Zero token counts and a zero cost are omitted, as in the footer. Context comes from the child's session stats (`12.4%/272k`, or `?/272k` when context is unknown after compaction). `CH` is the latest prompt cache-hit rate, shown only when that snapshot has cache activity. `(auto)` appears only after the child reports auto-compaction. Turns still count assistant responses, including tool-calling responses. Missing turns or cost are labelled unknown; a snapshot that only has a cost still shows `$cost`. Listing refreshes live snapshots first. These are Pi-reported figures, not subscription bills, and `(sub)` is not shown.

The TUI summary is `subagents: active/total • $cost` (three decimal places), lowercase and theme-dim, right-aligned above the model. Active counts starting, working and waiting-for-input children; total counts all tracked children in this parent session, including closed children and actual launch failures, but not preflight rejections. Cost sums the latest cumulative Pi session-stat snapshots, including closed children; resuming a child updates its existing snapshot rather than adding its previous cost again. Snapshots refresh after each assistant/tool-result message, persisted usage/summary entry, and turn/compaction completion, as well as startup/resume, settle and close. Costs therefore update during multi-turn work; an in-progress streaming response is not included until it completes. Missing/unavailable usage contributes zero to the numeric subtotal until reported; a compact `+` marker identifies incomplete cost reporting. These are Pi-reported costs, not guaranteed subscription billing amounts. Narrow terminals get a separate row. `src/footer.ts` decorates the actual `FooterComponent.prototype.render`; it is an isolated process-wide compatibility hook, not a supported Pi decoration API. It preserves stock rendering and restores the original method on shutdown. It assumes the directory/model remain the first two rows; completely custom footers that do not use that class are unaffected. RPC clients receive a normal status entry. Workflow workers are included in the same totals; workflows do not add a separate TUI footer status line. Full workflow state is available in the inspector.

## Persistence, reload, and migration

State lives in `<Pi agent directory>/subagents/<parent-session-id>/`: a registry, saved Pi sessions, and per-child event/stderr logs. Directories are private (0700), manager-written files 0600. Logs may contain sensitive code/task data and are capped at 20 MiB each (the final record may be truncated). There is no automatic retention/deletion policy.

Normal reload/session replacement/exit clears queues, requests abort, then sends SIGTERM with bounded SIGKILL fallback. Saved children are restored as stopped; resumption is explicit and does not replay interrupted tasks. It rechecks the **current policy and current availability** and recompiles the saved composition, not stale raw arguments. Already-running children are not silently reconfigured; normal parent reload stops them. Completed file edits are not rolled back.

**v1 records:** existing unrestricted child records remain visible/readable/closable, but cannot resume through the new tools because they lack a validated composition. Spawn a new allowlisted child instead. This deliberately prevents old executable/env/CLI settings bypassing the new policy.

A parent crash/SIGKILL may orphan processes; inspect and stop them before resuming sessions. Concurrent parent processes using the same parent session/registry are unsupported. Background daemons deliberately created by children are not guaranteed to be cleaned up.

## Future directions

The [roadmap](ROADMAP.md) records remaining communication, workflow and isolation ideas. Point-to-point peer messaging and the bounded workflow foundation are implemented; channels, shared boards, cross-parent messaging, dynamic/nested workflow graphs and sandboxing remain deferred.

## Development

```bash
cd subagents
npm ci --ignore-scripts
npm run check
npm test
# Also exercise the locally installed Pi executable (including its runtime):
PEER_TEST_EXECUTABLE="$(command -v pi)" node --import tsx --test test/peers-rpc.test.ts test/peers-parent-rpc.test.ts
```

For a no-model-call inspector playground, launch from the repository root:

```sh
pi --offline --no-extensions -e ./packages/subagents/extensions/subagents/index.ts \
  -e ./packages/subagents/test/fixtures/inspector-demo.ts
# /subagents shows this session's real background work.
# /subagents-demo opens synthetic workflow/worker data with simulated streaming.
# Add --tui-mode fullscreen to try the other layout.
```

The demo is a development-only fixture, not a shipped command. It launches no children and does not modify state. The workflow view uses a compact lane graph with one selectable step per row, not a two-dimensional box navigator. Artifact/log paths are displayed, not opened. Inspector tests exercise navigation, grouping, responsive graph/list switching, scroll following, theme/keybinding changes, bounded activity and non-acknowledging inspection. Graph tests walk the rendered wires of 300 deterministic DAGs to check that every real edge—and no invented edge—connects its intended nodes.

Peer tests cover graph permissions/non-transitivity, sender spoof rejection, bounded transport, concurrent directional accounting, definite rejection versus uncertain acceptance, receipts, renewal/reconnect, policy downgrade, input-blocked/stopped recipients, cancellation, reload/resume, and real parent→child-tool→peer exchanges. `test/fixtures/peer-parent-provider.mjs` also drives the same parent tool sequence in an isolated TUI with the prompt `PEER SMOKE`; it uses a deterministic provider, not a paid model.

Tests include policy precedence/trust, fail-closed parsing, model/resource filtering, prompt compilation, symlink boundaries, non-recursion, schema escape-hatch removal, lifecycle/cancellation/recovery, notification batching/read acknowledgements/explicit-close dismissal/reload recovery, reported-cost totals and report-only unread counts, preflight rejection without phantom records, both native-abort and Codex-shaped error-abort events with genuine-failure race coverage, and real Pi RPC policy enforcement using a deterministic local provider. End-to-end parent/child RPC tests verify that reading suppresses notifications and unread results trigger exactly one acknowledged report. No real credentials or provider calls are needed for automated tests.
