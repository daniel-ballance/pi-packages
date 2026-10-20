# subagents

Persistent Pi RPC children, composed by the parent from a user-controlled allowlist. No agent profiles: independently choose an allowed model/thinking combination, tools, resources and system-prompt instructions for each task.

## Install

```bash
# From the repository root:
npm ci --ignore-scripts
pi install ./packages/p3stack
```

Reload the parent manually or with `self_reload`. Requires Pi 1.3.0 or newer; tested with its Node CLI and the installed bundled executable on Linux (Node 22+ for development). TUI and RPC parents are supported.

## Disable native startup for one launch

`--disable-native-subagents` opts out of this package for that Pi launch,
including reloads. Pi parses extension flags after loading factories, so native
registration/startup is deferred until `session_start`. With the flag, no
`subagent_*` tools, `/subagents` or `/workflows` commands, Manager, workflow
runner, footer decoration or notification scheduler is initialized. Unrelated
extensions and skill discovery are unchanged. Normal unflagged TUI/RPC launches
retain the existing behavior; marked native Children still register nothing.

The flag does not edit `subagents.json`.

## Inside T3 Code

When T3 Code launches Pi with its MCP bridge, it sets `T3_MCP_URL`, and this
package stays inactive exactly as if `--disable-native-subagents` were passed.
T3's own `delegate_task`, `task_status` and `task_cancel` tools are the
subagent system there: T3's model configuration decides which providers and
models children can use, and T3 owns execution, permissions, completion
wake-ups and the subagent UI. This package is for running Pi directly.

## Bundled setup and execution skill

Installation also exposes `/skill:subagents` (unless skills are filtered out in your Pi package settings). Use it to choose policy scope, configure exact providers/models/tools/resources, diagnose unavailable compositions, and operate persistent children. The [skill](skills/subagents/SKILL.md) includes [complete example policies](skills/subagents/reference/configuration.md).

This is parent-side guidance, not automatic configuration or child resource inheritance. It does not overwrite user policies or grant permissions. Example model IDs are placeholders and must be replaced with exact available Pi identities. Model-selection research and analysis tooling are maintained separately in Pareto; they are not shipped or required by this execution package.

## Workflows

The bundled `/skill:workflows` helps the parent author and supervise JSON workflows using the same manager: task DAGs with explicit fan-out/all-input fan-in, command/agent/human checks, bounded repair and improvement loops, and optional peer task groups. The runtime schedules authorized work without manual parent relaying, retains artifact/validation history, and reports completion or exceptions rather than routine worker chatter.

See [WORKFLOWS.md](WORKFLOWS.md) for the contract, examples, observability, limits and explicit recovery. Start/inspect/control tools are `subagent_workflow_start`, `subagent_workflow_inspect`, `subagent_workflow_control`; `/workflows` is the human interface. These remain parent-only under the existing non-recursion guard. No new daemon or workflow permission schema: workers use current subagent policy; deterministic commands additionally require its `bash` permission. Each run explicitly sets concurrency, total attempts and a wall-clock deadline. Candidate paths/digest checks are not an OS sandbox.

## Allowlist: `subagents.json`

The highest-priority existing configuration wins, as a **whole-file replacement**:

1. `<launch cwd>/.pi/subagents.json`, only for a trusted project.
2. `<Pi agent directory>/subagents.json` (normally `~/.pi/agent/subagents.json`).
3. Built-in configuration shipped in `extensions/subagents/src/policy.ts`.

No merging or upward directory search. Reload Pi to pick up configuration edits. Resource/model availability is rechecked on catalog requests, spawn and resume. An invalid selected file disables new spawning/resumption instead of falling back to broader defaults. Listing, reading, aborting and closing tracked children remain available. Untrusted project configuration is ignored with a user-facing diagnostic.

The built-in policy applies only when no `subagents.json` exists. It is a menu across the common providers, so that multi-model workflows such as p3stack's roles and cross-family review work with no setup; entries you cannot reach are dropped without a diagnostic. Unlike your own file, where `maxDepth`, `loops` and `parentMessageLimit` stay off until you set them, it turns on nesting (`maxDepth` 2), bounded wake loops and messages to the parent (`parent_send`, 20 per assignment; see "Messages to the parent" below). When the collection's `claude-subscription` package is installed beside this one and its provider is registered, it also offers that provider's Claude models and maps its extension in `providerExtensions`. That map selects the extension for those children. A spawn can omit it from `extensions`. Without that, it is equivalent to the following:

```json
{
  "version": 1,
  "models": [
    {"id": "openai-codex/gpt-6-luna:medium", "description": "Fast and cheap: lookups, triage, routine edits."},
    {"id": "openai-codex/gpt-6-luna:high", "description": "Fast, more thorough."},
    {"id": "openai-codex/gpt-6.1-sol:medium", "description": "Strong general model."},
    {"id": "openai-codex/gpt-6.1-sol:high", "description": "Strong general model, more thinking."},
    {"id": "openai-codex/gpt-6.1-sol:xhigh", "description": "Hardest code and judgment."},
    {"id": "openai/gpt-6.1-sol:high", "description": "Strong general model (API key)."},
    {"id": "xai/grok-4.7:high", "description": "Code work."},
    {"id": "xai/grok-4.7:xhigh", "description": "Code work, more thinking."},
    {"id": "anthropic/claude-opus-5-5:high", "description": "Judgment and prose."},
    {"id": "anthropic/claude-opus-5-5:xhigh", "description": "Judgment and prose, hardest tasks."},
    {"id": "anthropic/claude-sonnet-5-5:high", "description": "Cheaper Claude reviewer."},
    {"id": "google/gemini-3.1-pro-preview:high", "description": "Another family for review panels."}
  ],
  "tools": ["read", "bash", "edit", "write", "grep", "find", "ls", "todo", "parent_send", "subagent_catalog", "subagent_spawn", "subagent_wait", "subagent_read", "subagent_close", "subagent_list", "subagent_send"],
  "extensions": [],
  "skills": [],
  "promptTemplates": [],
  "themes": [],
  "alwaysExtensions": [],
  "alwaysTools": [],
  "systemPrompt": true,
  "appendSystemPrompt": true,
  "contextFiles": true,
  "maxChildren": 6,
  "workingDirectories": ["."],
  "peerMessageLimit": 0,
  "parentMessageLimit": 20,
  "maxDepth": 2,
  "loops": {"enabled": true, "minIntervalMs": 60000, "maxIterations": 50, "maxDurationMs": 28800000}
}
```

### Field semantics

- `version: 1` and `models` are required. Model entries contain an exact `provider/model:thinking` ID and optional descriptive guidance. No fuzzy matches, implicit thinking-level changes or fallback models. Model IDs containing slashes or colons work; the final colon separates the thinking level.
- `tools` permits names, not shell commands. Recursive `subagent_*` tools are always filtered and diagnosed, even if declared. Built-in tools are known directly; extension tools must currently be discoverable in the parent's tool registry to be offered. Selected tools are also checked in the actual child before its task starts. A resource containing a tool does not independently grant permission to that tool.
- `extensions`, `skills`, `promptTemplates`, `themes` permit **explicit local resource files**, using Pi's CLI resource categories. Relative paths resolve against the configuration file's directory; `~/` is supported. For a skill, specify its `SKILL.md`. Directories, wildcards, remote package URLs and implicit resource discovery are intentionally not accepted in this iteration. Installed package resource files can be named explicitly.
- `alwaysExtensions` and `alwaysTools` name entries that every child receives without a parent selection, on spawn, resume and workflow workers. Each entry must also appear in `extensions` or `tools`, so the allowlists remain the complete permission set. Use `alwaysExtensions` for hooks, providers or renderers that should apply everywhere. An always-loaded extension's tools still require `tools` permission; list them in `alwaysTools` to activate them in every child, or leave them for per-spawn selection. Always-on entries become part of each child's saved composition. If any entry is unavailable (missing file, tool not locally known), spawning is disabled and the reason appears in `/subagents diagnostics`; children are never started without the entry.
- `systemPrompt` and `appendSystemPrompt` permit freely composed text for the corresponding CLI flags. Omit both spawn fields to use Pi's normal default/`SYSTEM.md`; supply `appendSystemPrompt` to augment it, or `systemPrompt` to replace it. Both may be supplied, matching CLI semantics. Pi may interpret an existing file path as prompt-file input, as it does on its CLI.
- `contextFiles` permits normal `AGENTS.md`/`CLAUDE.md` context discovery. It does not replace system-prompt handling. Children can opt out even when permitted. The resolved choice is saved for resume validation.
- `workingDirectories` permits directory roots and their descendants. Relative roots resolve against the parent launch cwd, **not** the configuration directory. Real paths are checked so symlink traversal cannot escape an allowed root. The default is `["."]`.
- `peerMessageLimit` is an integer from 0 to 1000, default **0 (disabled)** in both built-in and user policies. A positive value caps each directional peer-message allowance. Also allowlist `peer_send` and explicitly select it in each participating child's `tools`. No existing policy gains communication implicitly. This limits message-triggered turns, not tokens or provider costs.
- `parentMessageLimit` is an integer from 0 to 1000: how many `parent_send` messages a child may send its parent during one assignment. Omitted means **0 (disabled)** in user files; the built-in policy uses 20. Also allowlist `parent_send` and select it in each child that should have it. See "Messages to the parent" below.
- `maxChildren` is the live-process cap for the whole tree, idle children included. `0` turns spawning off. `-1` removes the cap. A positive safe integer is the cap, up to `Number.MAX_SAFE_INTEGER`. An omitted field means 4. The built-in policy, used only when no file exists, stays 6. Any other value makes the policy invalid. The old `PI_SUBAGENTS_MAX_CHILDREN` override remains unused.
- In user files, omitted tools/resources mean empty allowlists and omitted permission booleans mean `false`. They do not inherit built-in permissions. Unknown configuration fields are errors.

No user configuration files are generated or overwritten automatically.

### Effective catalog and diagnostics

`subagent_catalog` exposes only usable options: allowed exact models with configured authentication and supported thinking levels, their guidance, modalities, context/output limits and registry pricing; locally known tools; existing resource files; prompt permissions; and allowed directories. Descriptions are user guidance, not measured model benchmarks. Registry prices may not reflect subscription billing or your actual provider bill.

Each built-in entry is offered only if that exact model is registered, authenticated and available with the requested thinking level. The descriptions are rough guidance, not task-quality, cost or subscription-capacity claims. To permit other exact combinations, supply a complete global or trusted-project policy. Existing policies replace the fallback and are not rewritten by this package.

Custom policies can supply advisory descriptions, which the catalog passes through without interpreting them as routing rules or additional permissions. Registry metadata and actual child usage remain available for execution supervision; model rankings and research analysis are outside this package.

Other extensions can read the usable models without a tool call: emit `{ reply }` on the `pi.events` channel `subagents:catalog`, and `reply` is called synchronously with `{ spawnEnabled, models }`, where `models` lists exact `provider/model:thinking` identities. p3stack's `/p3stack-setup` uses this so that it offers only models a Child may use. Nothing replies under T3 or before the session starts.

Unavailable entries are omitted, never silently substituted. Their names/reasons are shown to the **user** through `/subagents diagnostics`; the model-facing catalog contains only an omitted-entry count. If no model is usable, spawning is disabled until configuration/availability is fixed.

Configured credentials do not guarantee a successful request: expired authentication, provider outages, remote entitlement problems, and resource load errors can still surface at launch/use. Custom provider models must also be configured in the child environment or supplied by an explicitly selected extension. A model whose provider an extension registered (for example `claude-subscription`) is marked `requiresExtension` in the catalog unless `providerExtensions` maps that provider. Children start with `--no-extensions`. A mapped provider extension is selected for the child without being named in `extensions`. The mapped file must still be in the `extensions` allowlist. `compile` names the mapped file in an error only while the catalog still enables spawning. While the catalog still enables spawning, the extensions allowlist check runs before the mapped file is resolved, so a spawn of a missing file outside that allowlist fails with the allowlist error, not the missing-file message. Whenever the catalog disables spawning, `compile` throws `No spawnable configuration` and does not name the mapped file, for example when the only model maps to a missing file, or when `alwaysExtensions` lists a missing mapped file even if another model is usable. An unmapped provider still requires the spawn to name its extension. The child must resolve the exact requested model/thinking selection; fallback is rejected before sending the task.

## Managed built-in extensions

Pi supplies the client and executors: this package adds policy checks, not another MCP client. Select exact `builtin:codemode`, `builtin:tool-search`, or `builtin:mcp` identifiers from the catalog. Existing policies gain nothing implicitly; unknown built-ins and `builtin:llama.cpp` are rejected. Codemode classifiers and virtual model selection are not supported.

See [built-in grants and settings](skills/subagents/reference/builtins.md) for the exact fields, credential consent, configuration eligibility, limitations and minimal migration snippets. The legacy `mcp-client` package remains unchanged and is not needed for this integration.

## Tools

| Tool | Purpose |
|---|---|
| `subagent_catalog` | Discover allowed, currently usable ingredients |
| `subagent_loop` | Wake this parent on an interval until a stop condition holds; `start`, `stop`, `status`. Disabled unless the policy has `loops` |
| `subagent_spawn` | Compose and start a child. Returns acceptance, not completion, as a compact child entry with model, thinking, overlap warnings, and any created worktree |
| `subagent_list` | `{ totals, agents }`: aggregate reported cost/live counts plus child status, unread counts, usage and paths |
| `subagent_send` | Prompt an idle child, or explicitly steer/queue a follow-up for a working child; returns the observed input `disposition` |
| `subagent_connect` | Parent authorizes a bidirectional peer link with independent directional allowances |
| `subagent_disconnect` | Disable a link without erasing counters/history or stopping children |
| `subagent_renew` | Parent explicitly replenishes one direction's allowance |
| `subagent_peers` | Inspect links/counters and paginated peer-message history |
| `subagent_read` | Read new output or replay from a cursor; the page also carries the child's `model` and `thinking` |
| `subagent_wait` | Block until the selected children have news, with no time limit unless `timeoutSeconds` is set. Returns `{ wake, agents }`, a compact status for each child with its new reports, and acknowledges those reports unless `collect:false`. `final:true` returns a settled child's last report when it fits. The Waiting for news section names what stays unread. |
| `subagent_abort` | Clear queues and cancel work, keeping the child alive |
| `subagent_close` | Abort and stop a child, dismissing pending notifications but retaining readable results and conversation |
| `subagent_release_hold` | After discussing a human intervention, release a child or workflow hold without starting work |
| `subagent_resume` | Revalidate a stopped child's saved composition, restart and optionally prompt it |
| `subagent_respond` | Queue an answer to a pending extension dialog; human-required approvals remain human decisions |
| `subagent_workflow_start` | Start a parent-authored JSON workflow; returns acceptance |
| `subagent_workflow_inspect` | Inspect run/step progress, artifacts, validation and attempts |
| `subagent_workflow_control` | Pause, explicitly resume/retry, or cancel a workflow |

`subagent_spawn` shares the compact per-child entry from `subagent_wait`, without `reports`. It adds `model`, `thinking`, `coordinationWarnings`, `coordinationWarningCount`, `worktree` when created, and `overlapsOutsideYourSubtree` when nonzero. Direct and proxied spawns omit the task, usage, and session/log/stderr paths. `subagent_list` still returns the full summary, including `lastSubmission.disposition`.

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

`tools` is required; `[]` disables tools. Resource arrays are optional and empty by default. Optional `coordination: { owns: ["src/auth.ts"], outputs: ["reports/auth.md"] }` declares work areas and expected outputs. Paths resolve against the child cwd; overlap warnings are advisory, not locks, permissions or a sandbox. They do not create worktrees or merge changes.

Optional `worktree: true`, or `worktree: { base, branch }`, gives the child its own git checkout: the manager runs `git worktree add -b <branch> <repository of cwd>/.pi/worktrees/<name>-<random> <base>` (defaults: `HEAD` and `subagent/<directory>`) and spawns the child there. Everything is validated before git writes anything: the composition, the branch name (a valid new branch, never option-shaped), the base (resolved to a commit, so git only sees a commit ID), and the destination, which must lie inside `workingDirectories` through the real path of its nearest existing directory. If anything fails after git starts, including a failing checkout hook or a child that does not launch, the checkout and branch this attempt created are removed; a branch or checkout that another process created in the meantime is left alone. The destination check and git's own path resolution are separate steps, so a process that can write to the repository could still swap a directory for a symlink between them. That is within this package's stated limit: it is not a sandbox against processes with write access (every child with `bash` has it), and the child is still refused if its checkout ends up outside `workingDirectories`. The result carries `worktree: { path, branch, base, head, ignored }`; `ignored: false` means the repository does not ignore `.pi/worktrees/`, so the parent checkout shows the new one as untracked. Creation only: merging the branch and removing the checkout stay with the parent, and closing the child leaves both in place. It is a separate checkout, not a sandbox.

There are **no executable, raw CLI argument, environment, separate thinking-level or resource-discovery overrides** in the parent-facing spawn tool. The manager compiles validated selections into CLI arguments. It always loads its own child guard, regardless of configuration.

All normal extension, skill, prompt-template and theme discovery is disabled; only explicitly selected resources load. Context files and normal system prompts follow their own permitted settings. Parent project trust is propagated only within that project's directory tree; child directories outside it do not automatically inherit trust. Children still use normal Pi global settings and credentials, so this is a spawn-composition boundary rather than a hermetic configuration or sandbox.

A completed child remains idle. `subagent_list` also provides structured capacity/recovery guidance, identifying idle and held workers without recommending automatic release. Use `subagent_send` for discussion or another assignment. On a working child, specify `behavior: "steer"` or `"followUp"`; steering is delivered at a tool boundary, while `subagent_abort` cancels current work. Cancelling `subagent_wait` (Escape) stops the wait, not the children. `subagent_respond` removes a pending dialog only after the child stdin write callback succeeds; its result reports transport `queued` and receipt `unconfirmed`, because Pi's extension UI response protocol has no acknowledgement record.

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

### Waiting for news

An agent with nothing else to do this turn ends its turn, and finished children's reports wake it. It calls `subagent_wait` only when its next step in the same turn needs a result. The wait blocks until one of these holds, and `wake` names the first in this order:

- `hold`: a selected child is under a human hold. Discuss it with the user before releasing anything.
- `input`: a selected child waits on an extension dialog, even when a sibling has settled in mode `any`.
- `settled`: all selected children (mode `all`, the default) or any of them (mode `any`) are no longer starting, working, waiting for input or stopping.
- `child_message`: a selected child sent the waiting agent a message with `parent_send` and is probably still working. The message is in that child's `reports`. A wait with `collect:false` acknowledges nothing, so the next wait ends the same way until the message is read.
- `message`: a message for the waiting agent is queued. It arrives after the result, or when the agent ends its turn. One queued batch ends one wait, so a follow-up that stays queued until the turn ends does not end every later wait in that turn.
- `timeout`: `timeoutSeconds` passed. Without `timeoutSeconds` there is no deadline, and `0` checks once.

To keep waiting past a child that needs input or is held, pass the other children's IDs.

Each entry in `agents` carries the child's `id`, `name`, `status`, `activity`, `error`, `hold`, `uiRequests`, `depth`, `parentId` and `resultReview` (its `status` only) where they apply, plus `unread`, and nothing else from the record. `resultReview` shows the record after the wait's acknowledgement, so a result that spills to a file still shows `unreviewed`. `subagent_list` and `subagent_read` keep the task, usage, paths and timestamps. By default the wait also returns each child's new reports inline as `reports`, oldest first, and acknowledges them, so they do not arrive again as a report message. It leaves out `sent` and `lifecycle` echoes but acknowledges them with the reports around them. Reports share a 24 KB budget that the status entries come out of first, so a large selection trims reports instead of spilling the result to a file. `unread` counts the reports a result did not include. Read those with `subagent_read`. A result that still spills acknowledges nothing. `collect:false` returns status only and acknowledges nothing.

`final` defaults to false, so a wait that omits it returns the same reports as before. With `final: true`, a settled child returns its last report when that report fits the 24 KB and 750 line budget. The wait acknowledges the updates before that report. When the report fits and the result does not spill, a later `subagent_read` returns none of the updates the wait already saw. A final that does not fit the budget stays unread. A child that is still starting, working, waiting for input, or stopping is skipped when it has no `message`. The skip does not apply when the last report is `error`, `failure`, `input_requested`, or `human_intervention`. The wait returns that report. A working child that sent a `message` still returns the fitting prefix. That prefix can include earlier progress. `collect: false` reads nothing and acknowledges nothing. A result that spills to a file acknowledges nothing. The 24 KB and 750 line caps are unchanged.

A wait collects a child's reports only when they would otherwise reach the caller. A root wait therefore leaves a live coordinator's own children to that coordinator, and a coordinator's wait collects its direct children.

## Messages to the parent

A child can message its parent while it works, without finishing its run: a finding that changes the plan, a blocker, a decision it needs. Select `parent_send` in the child's `tools`; the policy must allowlist it and set a positive `parentMessageLimit`. The mandatory guard provides the tool, so no extra resource is needed.

```text
parent_send({ message: "parser.ts already handles v2; the migration is half the size you expected" })
```

The call returns at once with `{ delivery: "queued", to, remaining }`. It does not wait for a reply. The message travels over the child's private pipe, so the manager, not the message text, says who sent it.

The parent gets it like any other report:

- If the parent is in `subagent_wait` on that child, the wait ends with `wake: "child_message"` and the message in the child's `reports`.
- Otherwise it arrives in the next report batch, when the parent's turn ends. It never interrupts the parent mid-turn.
- `subagent_read` returns it as an update of kind `message`, and reading it acknowledges it.

To answer, the parent uses `subagent_send`; `behavior: "steer"` reaches a working child at its next tool call. A nested child's message goes to the coordinator that spawned it, like its other reports, and reaches the root only if that coordinator stops before reading it.

The limit counts messages per assignment, and a new assignment starts a fresh count. A send over the limit is refused, and the child is told to put the rest in its final reply. Held children cannot send. Workflow workers cannot select `parent_send`, because the workflow runtime consumes their output. Messages are delegated work output, **not user instructions or permission grants**.

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

## Wake loops

`subagent_loop` (and the `/loop` command for the human) repeats a task on an interval: each tick is a custom message, `subagent-loop-tick`, that starts a parent turn. A tick reaches only an idle parent with no pending human-intervention notice; one that falls due during a turn waits until the turn settles, and ticks never stack. The interval may not exceed the run's duration, and the deadline is enforced on time, even while a tick waits. The loop ends when the parent calls `subagent_loop({op: "stop"})`, when the human runs `/loop stop`, or at the policy's iteration or duration bound; a bound adds a `subagent-loop-end` message without starting a turn. One loop runs per parent, and a reload stops it.

Loops are off by default. The policy's `loops` field enables them and caps the interval, tick count and duration (see the [configuration reference](skills/subagents/reference/configuration.md)). Under T3 Code this package is inactive; T3's `schedule_task` and `watch_pull_request` cover the same need. A watcher child whose task is "watch X and report" also wakes the parent, through its completion notice, without a loop.

## Bounded nesting: one root Manager

Managed children receive `PI_SUBAGENT=1`. This extension registers **no manager, management tools or commands** inside such a child. A mandatory child guard removes unselected tools from the active tool set and blocks their execution even after dynamic reactivation. The manager checks the selected tools are actually available before sending the task. Neither project nor global policy can disable this guard.

By default (`maxDepth: 1`) a child cannot delegate: configured `subagent_*` names are filtered with a diagnostic. A policy with `maxDepth` of 2 to 4 may allowlist the delegation tools `subagent_catalog`, `subagent_spawn`, `subagent_send`, `subagent_wait`, `subagent_read`, `subagent_close` and `subagent_list`, and a parent may then select some of them for a child above the deepest level. Inside that child they are **proxies**: each call travels over the child's private, manager-bound pipe to this one root Manager, which re-validates the arguments, composes grandchildren from the **same allowlist**, and records each child's `parentId` and `depth`. A child acts only on its own descendants; the peer, hold, resume, respond and workflow tools stay parent-only, and workflow workers never delegate. A child at the deepest level cannot be given delegation tools, and `alwaysTools` can never include them.

Because one Manager owns every child, everything that already covered children covers the whole tree: `maxChildren` is the live cap for all levels together, `subagent_list` and `/subagents` show every child (nested rows name the child that delegated them), and reported costs sum across the tree. Closing, aborting, halting or killing a child does the same to its whole subtree, including descendants that have stopped; while that runs the child and its descendants cannot delegate, and a halt or kill holds saved descendants too, so none resumes while an ancestor is held. A nested child's routine reports wait for its own parent, which drains them with `subagent_wait` and `subagent_read`; a coordinator's read never settles an input request. A coordinator's `subagent_wait` runs as root waits of at most 60 seconds that collect nothing, then one final wait that collects, so it has no time limit either. It watches the coordinator's own queue, so a message from the root or a peer ends it with `wake: "message"`; the root operator's messages never end it. Human-intervention notices and input requests always reach the root, and so does any report still unread when its child's parent stops. A cascade that cannot confirm a descendant lists it under `subtreeFailures`. A delegated call is cancelled if its caller exits or cancels it, a request too large for the pipe is refused before it is sent, never spills to a file, and replies within one pipe frame (a larger reply comes back as a truncated preview with how to narrow it); errors and warnings name only records in the caller's subtree. When the live cap is full, the refusal names the limit. A nested caller is also told that the limit counts every live child in the tree and that it can close only its own idle children. `docs/adr/0002-nesting-through-one-root-manager.md` in the repository records the rejected alternative.

This does **not** prevent a child with unrestricted bash from invoking Pi itself, nor does it isolate arbitrary code in an explicitly trusted extension. Shell-level blocking and sandboxing remain out of scope.

## Reports and UI

Tool calls use compact, themed TUI summaries instead of raw JSON by default. Rendered chrome and display names are lowercase; task/output text, identifiers, paths and expanded payloads retain their original case. Call rows start with `subagents •` to identify their source (`subagents • catalog`, `subagents • list`); child and workflow actions also retain their target name and parameters.

- **Catalog:** availability, model options, tool names and child limit.
- **Spawn/send/resume/abort/close/respond:** a two-line card. The first line is the state glyph, the child's name and its state word, with the model and effort right-aligned (`opus-5-5 · xhigh`; the provider and variant suffixes are dropped). The second line is what the child is doing or what its last run came to, then elapsed time, turns and cost. Spawn adds the task and any work-area overlap warnings.
- **List/wait:** the same card for up to four children, then a count of the rest and how many need attention. List adds aggregate usage. Wait adds a banner for every wake reason except `settled`, a count of reports it did not show, and previews of up to two returned replies (a child's message when it has no reply yet). A wait card has no model, elapsed time or cost, because the wait result does not carry them.
- **Read:** the child's card, then the latest assistant reply (or, without one, its latest `parent_send` message) rather than lifecycle/sent echoes, plus errors, history gaps and pagination warnings. A pending input request is the card's activity (`needs input: <title>`).

Expand tool output (Ctrl+O by default, respecting Pi keybindings) to see the full returned JSON, including paths, policy guidance and all returned updates. Collapsed views bound reply previews and large lists. On a narrow terminal a card shortens the activity before the name, and drops the model badge whole rather than cutting it. Truncated tool results explicitly show the saved full-result path. Rendering is presentation-only: model-facing content, RPC payloads, output caps and read acknowledgements are unchanged. Rendered statuses are snapshots at the time of each tool result, not live widgets.

Completion, failure, extension input requests and `parent_send` messages become durable **pending notifications in the manager**, not immediately queued parent messages. Reading an update through `subagent_read` acknowledges it, removing its pending notification—even if that read happens just before the child settles. Acknowledgement is keyed by child ID and update cursor, so reading an earlier result cannot suppress a newer run. `subagent_list` and `subagent_wait({collect:false})` do not acknowledge findings. A default `subagent_wait` acknowledges the reports it returns. Explicit `subagent_close` dismisses that child's ordinary pending notifications, even if its result was never read; human intervention events remain pending until delivered. It does not delete or advance the result history. Already-delivered reports cannot be retracted. Parent reload/exit shutdown is different: unread pending notices are preserved for recovery.

While the parent is working, notices stay in the manager. When it settles (or when a notice arrives while it is already idle), a short 100ms batching window collects remaining unread notices into one attributed custom report, with at most eight short summaries per batch. Idle state and pending notices are rechecked immediately before sending. Remaining batches wait for another idle opportunity. A report is marked delivered only when it enters the parent's message history; it is not announced again. Pending notices and read/delivery acknowledgements persist across reloads. Startup reconciles saved report receipts with the registry, and expired/stopped-child dialogs are discarded. Old registries without a pending queue do not synthesize historical notifications.

These reports are delegated work output, **not user instructions or permission grants**. Routine tool chatter stays in logs. Ordinary child questions can be answered with `subagent_send`; extension dialogs use `subagent_read.uiRequests` and `subagent_respond`. Reading raw log/session files through ordinary file tools is not tracked as a notification acknowledgement.

```text
/subagents
/subagents list
/subagents diagnostics
/subagents halt <id>
/subagents kill <id>
```

In the TUI, `/subagents` opens an **observational, keyboard-navigable overlay with emergency Halt/Kill controls**. Each overview row is one line: a bar and glyph in the state's colour, the name, a `[model effort]` badge, and what the child or run is doing. Rows sit under `attention`, `working` and `results` rules, and the subtitle is the status legend. Workflow workers are grouped under their run rather than listed alone, and inspecting a child does not mark its parent reports reviewed. Fresh results stay visible; historical work remains accessible through History. Enter drills into a workflow's dependency map, step, attempt and worker. The map draws a downward lane graph: branches and joins are connected, horizontal arrows show edge direction, and `╪` marks a crossing **without** a join. Fan-in, skipped layers, independent roots, seed and check-input dependencies are preserved. Nodes show their live state and task/check/loop kind. Node positions depend on the definition, not changing execution state. Narrow terminals and dense graphs switch to an explicit prerequisite list rather than hiding edges; resizing preserves the selected step. Step/attempt views expose instructions, checks, loop iterations, verdicts, artifacts and saved paths; they do not run commands or open artifact files.

A worker view's header is the same row with turns and cost added, above the full `provider/model:thinking`. Worker views foreground purpose, current activity, assignment timing, latest results and human holds, followed by retained assistant updates, actual tool calls/results and streaming text. Secondary details contain composition, coordination declarations and saved paths. Peer views show connections, directional allowances and paginated delivery history, without acknowledging parent reports. Tool activity and partial text are bounded, transient presentation data; they are not reconstructed from saved logs after reload. Hidden thinking is never displayed. Up/down navigates choices (or scrolls worker output); PageUp/PageDown scrolls details; Home goes to the top and End resumes following worker output. Selection and scroll anchors survive live updates. Esc returns one level, then closes; closing never stops work. Pi's configured selection keybindings are respected. The viewer never advances read cursors or acknowledges reports intended for the parent. Messages, resumption, release and child-dialog handling remain parent responsibilities. The viewer only adds Halt and confirmed break-glass Kill, with operation results and automatic parent notification.

`/subagents list` (also bare `/subagents` in RPC mode) lists each child as `<glyph> name (id) · state · provider/model:thinking · activity · elapsed · N turns · <footer stats>`, with the glyphs and state words of the legend below. The stats are the bottom-left Pi footer line: `↑input ↓output RcacheRead WcacheWrite CH% $cost context%/window (auto)`. Zero token counts and a zero cost are omitted, as in the footer. Context comes from the child's session stats (`12.4%/272k`, or `?/272k` when context is unknown after compaction). `CH` is the latest prompt cache-hit rate, shown only when that snapshot has cache activity. `(auto)` appears only after the child reports auto-compaction. Turns still count assistant responses, including tool-calling responses. Missing turns or cost are labelled unknown; a snapshot that only has a cost still shows `$cost`. Listing refreshes live snapshots first. These are Pi-reported figures, not subscription bills, and `(sub)` is not shown.

The TUI summary is `subagents: active(+idle)/cap of total • $cost` (three decimal places), lowercase and theme-dim, right-aligned above the model. Active counts starting, working and waiting-for-input children. Idle counts live children that are not active. The summary writes that count as `(+N)` and leaves it out when the count is zero. The cap is the configured live-child limit, `∞` when that limit is unlimited, and `off` when spawning is disabled. Total counts all tracked children in this parent session, including closed children and actual launch failures, but not preflight rejections. Cost sums the latest cumulative Pi session-stat snapshots, including closed children; resuming a child updates its existing snapshot rather than adding its previous cost again. Snapshots refresh after each assistant/tool-result message, persisted usage/summary entry, and turn/compaction completion, as well as startup/resume, settle and close. Costs therefore update during multi-turn work; an in-progress streaming response is not included until it completes. Missing/unavailable usage contributes zero to the numeric subtotal until reported; a compact `+` marker identifies incomplete cost reporting. These are Pi-reported costs, not guaranteed subscription billing amounts. Narrow terminals get a separate row. `src/footer.ts` decorates the actual `FooterComponent.prototype.render`; it is an isolated process-wide compatibility hook, not a supported Pi decoration API. It preserves stock rendering and restores the original method on shutdown. It assumes the directory/model remain the first two rows; completely custom footers that do not use that class are unaffected. RPC clients receive a normal status entry. Workflow workers are included in the same totals; workflows do not add a separate TUI footer status line. Full workflow state is available in the inspector.

### Status legend

Every surface shows a child's state as one glyph and one word from a single table; colour repeats what the glyph says. A human hold outranks a failure, a failure outranks waiting for input, and only a settled child shows whether the parent has read its latest result. Workflow runs, steps, attempts and tool events use the same glyphs.

| Glyph | State | Meaning |
|---|---|---|
| `○` | starting | The process is starting |
| `●` | working | Running a task |
| `?` | waiting | Waiting for input or a human approval |
| `=` | held | Halted or killed by the human; held for the parent |
| `!` | failed | The process or its last run failed |
| `*` | unread | Settled, with a result the parent has not read |
| `✓` | reviewed | Settled, and the parent has read its result |
| `·` | stopped | Settled or closed with nothing to review |

## herdr status

In a [herdr](https://herdr.dev) pane with herdr's Pi integration installed (`herdr integration install pi`), the pane stays `working` while subagents or workflows run, even after the parent settles. herdr's integration reports only the parent, so without this the pane goes idle while children are still busy. A display-only working label says why: `2 subagents` while the parent is settled, `working + 2 subagents` while both are busy, and `1 subagent, 1 workflow` for mixed work. The same text is exposed as the `subagents` pane token for custom herdr sidebar rows (`$subagents`).

Active means the same as the footer: starting, working and waiting-for-input children, plus running or pausing workflows. When the last one finishes, the pane goes idle, which herdr shows as done until you view it.

How it works, and its limits:

- herdr gives lifecycle authority to the official `herdr:pi` source and ignores state from other sources, so the parent co-reports under `herdr:pi`, from Pi itself, with a higher `seq`. Labels use display-only metadata under this package's own `pi-subagents` source.
- Nothing is reported until a subagent first runs; sessions that never spawn one are left entirely to herdr's integration. Once engaged, the integration's own reports are outranked for the rest of that runtime, so this mirrors its whole state machine (blocked, then working, then idle), including `herdr:blocked` events.
- `/reload`, `/new` and `/resume` load fresh extensions; herdr's integration takes back control and children stop as usual. Labels and the token are cleared on reload and on exit. If Pi is killed outright, the `subagents` token can remain until the pane closes.
- TUI parents only, like herdr's integration. Nothing is sent outside a herdr pane or with `--disable-native-subagents`. Without the integration installed, herdr ignores these reports. Delivery failures are ignored.
- This relies on herdr's current reporting contract (tested with herdr 0.8.2 and integration version 8), including its reserved `herdr:` source prefix. A future herdr change could make it a no-op.

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
pi --offline --no-extensions -e ./packages/p3stack/subagents/extensions/subagents/index.ts \
  -e ./packages/p3stack/subagents/test/fixtures/inspector-demo.ts
# /subagents shows this session's real background work.
# /subagents-demo opens synthetic workflow/worker data with simulated streaming.
# Add --tui-mode fullscreen to try the other layout.
```

The herdr status test is opt-in because it needs herdr and a real `pi` executable on `PATH` (herdr recognises agents by process name, so the dev-dependency CLI under node cannot stand in):

```bash
HERDR_E2E=1 node --import tsx --test test/herdr-e2e.test.ts   # HERDR_E2E_PI=/path/to/pi to override
```

It starts a throwaway herdr session, installs herdr's current Pi integration into a temporary agent directory, and drives a real Pi TUI with real children and scripted offline models. It covers settled parents with running children, staggered and failed children, parent turns and `herdr:blocked` while engaged, workflows, `/reload`, quitting mid-child, RPC/opt-out silence and a missing integration. It does not touch your Pi configuration or default herdr session.

The demo is a development-only fixture, not a shipped command. It launches no children and does not modify state. The workflow view uses a compact lane graph with one selectable step per row, not a two-dimensional box navigator. Artifact/log paths are displayed, not opened. Inspector tests exercise navigation, grouping, responsive graph/list switching, scroll following, theme/keybinding changes, bounded activity and non-acknowledging inspection. Graph tests walk the rendered wires of 300 deterministic DAGs to check that every real edge—and no invented edge—connects its intended nodes.

Peer tests cover graph permissions/non-transitivity, sender spoof rejection, bounded transport, concurrent directional accounting, definite rejection versus uncertain acceptance, receipts, renewal/reconnect, policy downgrade, input-blocked/stopped recipients, cancellation, reload/resume, and real parent→child-tool→peer exchanges. `test/fixtures/peer-parent-provider.mjs` also drives the same parent tool sequence in an isolated TUI with the prompt `PEER SMOKE`; it uses a deterministic provider, not a paid model.

Tests include policy precedence/trust, fail-closed parsing, model/resource filtering, prompt compilation, symlink boundaries, non-recursion, schema escape-hatch removal, lifecycle/cancellation/recovery, notification batching/read acknowledgements/explicit-close dismissal/reload recovery, reported-cost totals and report-only unread counts, preflight rejection without phantom records, both native-abort and Codex-shaped error-abort events with genuine-failure race coverage, and real Pi RPC policy enforcement using a deterministic local provider. End-to-end parent/child RPC tests verify that reading suppresses notifications and unread results trigger exactly one acknowledged report. No real credentials or provider calls are needed for automated tests.
