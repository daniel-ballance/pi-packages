# Retired T3 Code and Pi subagents integration

> Retired by the pinned host map and one-package consolidation. See [About p3stack](p3stack.md) for the current host contract. The integration notes below are historical.

Research date: **2026-10-06**. The findings and evidence limits below describe the initial read-only research phase.

**Superseded 2026-10-14:** the `t3-subagents` wrapper package was removed. Inside T3 Code, Pi uses T3's own `delegate_task`/`task_status`/`task_cancel` tools directly and the native `subagents` package stays inactive (it detects `T3_MCP_URL`). See [the revamp note](t3-subagents-revamp.md). The research below is kept as history.

**Implementation follow-up:** the user chose launch-scoped native opt-out plus a separate T3-owned executor. The first slice lived in `packages/t3-subagents`; [`subagents`](../packages/subagents/README.md) implements `--disable-native-subagents`. User T3 settings and Allowlists remain untouched. Pi RPC fixtures cover both launch paths and nested hooks. A subsequent [live smoke test](t3-code-subagents-smoke-test.md) exercised the new wrapper through the installed T3 bridge, including real completion, active cancellation and saved-session recovery, without changing user launch settings. The installed T3 cancellation contract and audited upstream cancellation implementation differ; the package documents that version-dependent scope.

## Original research recommendation

**Keep the existing Pi subprocess backend. Make it safe under T3, then integrate its lifecycle with T3's native-subagent projection.** Add an explicitly separate T3-owned task executor later if cross-harness workflow execution is useful. Do not silently replace `subagent_spawn` with `delegate_task`: their ownership, permissions, follow-up, and completion contracts differ.

The most urgent issue is not missing task cards. Your package deliberately starts a parent follow-up when an unread result arrives while the parent is idle. T3's Pi adapter deliberately rejects agent work that starts without a T3-owned turn. These two reasonable designs conflict. [L1][L2][T1]

## Evidence and limits

- Inspected this repository at `cc1fd814fdd32e8862e97934328f5df811ba4e48`, including the package implementation and tests. A bounded read-only Pi child independently audited the package; its findings were checked against source and the child was closed.
- Read primary T3 source at [`pingdotgg/t3code`, `f21d6da51c9aa78ea12e7f13a378f55f1e63cb38`](https://github.com/pingdotgg/t3code/tree/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38), retrieved on the research date. T3 links below are pinned to that revision.
- The local `t3` launcher points to `0.0.46-nightly.20261005.2689`. Inspected its generated `.t3/caches/pi-t3-mcp-extension.ts`, SHA-256 `ee4ccd63dae4d84ee21cf7f41859e755c3e8ec09577d8682e13162eba0b15b3b`. It implements the injected tool bridge and permission hook described below. The installed executable also contains the exact unsolicited-work error quoted below. This corroborates relevant deployment mechanisms, not full equivalence with upstream HEAD.
- Called live `orchestrator_capabilities` and `subagent_catalog`. T3 reported this as a Pi/full-access parent, with Pi, Codex, and Grok child-task targets available. The local native catalog was a narrower six-selection allowlist, read/search-only, with four live children maximum and peer messaging disabled. For example, the parent Pi model was advertised by T3 but absent from that native allowlist. **The two catalogs describe different authority domains.** No policies were changed.
- Read installed Pi **1.0.3** documentation and extension/RPC examples. The stable package targets Pi **0.99.2+**; any new integration must feature-detect/version-test the interface it uses. Current documentation is not proof an interface existed in every supported release. [L6][P1]
- Read T3's relevant tests; did not install T3 dependencies or run its test suite. Did not deliberately reproduce a parent termination, launch a T3 child, or exercise supervised-mode approvals. The compatibility conclusions are source-derived, not an end-to-end certification.
- Some T3 documentation lags code: the MCP guide says Pi has no MCP client, whereas installed Pi documents built-in MCP; that guide also differs from the deployed tool description on terminal-task cancellation. Prefer versioned schemas, implementation, and live tool descriptions over broad prose claims. [T5][T6][P3]

## 1. How T3 handles subagents

### Two kinds, one UI

T3 explicitly distinguishes `app_owned` and `provider_native` subagents in its shared schema. A subagent record has a parent node/run, provider identity, status/progress/result, native task reference, and nullable child thread ID. [T4]

**App-owned delegation:** `delegate_task` enters the authenticated MCP endpoint, dispatches `delegated_task.request`, creates a child T3 thread/run with subagent lineage, and executes through the normal provider adapter. Provider/model/modes inherit unless explicitly selected; the child receives the supplied task, not the parent transcript. Child threads inherit the parent workspace through the child-thread construction. Runtime and interaction privileges cannot escalate. [T5][T6][T7]

**Provider-native observation:** an adapter projects work the underlying harness already owns. For Pi today this is a narrow compatibility adapter for the official example extension: it recognizes exactly `toolName === "subagent"`, then `details.results[]` containing `agent`, `task`, messages, and completion/error fields. It creates native task cards with `childThreadId: null`; even a `sessionFile` field is intentionally not adopted as a T3 child thread. Unknown shapes remain dynamic-tool output. [T2][T3]

Consequently, this package's `subagent_spawn`, `subagent_send`, `subagent_read`, and workflow tools execute in Pi but do **not** meet that task-card contract. Their tool results contain manager records rather than the example extension's result array. [L1][T2]

### Durable completion is more than a turn ending

T3 delegation returns stable task/thread/run identifiers. `mode: "async"` returns admission/current state; `mode: "wait"` waits within a budget, and timeout does not cancel work. `task_status` distinguishes `working`, `waiting_for_children`, and `result_available`. Known live subagents, pending result delivery, and provider background work can defer publication after a child turn has ended. Reading a terminal task can acknowledge its automatic parent delivery. Published results remain distinct from later child-thread runs. [T5][T6][T7]

Async completions are offered through T3's durable parent delivery/continuation machinery. This is not an extension independently starting inference inside the Pi process. T3 has the turn owner, timeline, queue, and persisted delivery state. [T6][T7]

`delegate_task` is **not** a persistent collaborator interface. The documented review contract requires a new delegated task per review round, with the original brief and accumulated context. Sending to the backing `childThreadId` does not reopen the original task. Ordinary thread messaging exists, but is a different contract. Likewise, `create_threads`/`t3_thread_launch` create ordinary top-level conversations, not delegated work. [T5][T6][T9]

### How T3 drives Pi

The adapter runs `pi --mode rpc`, preserves Pi's normal extension/resource discovery, and stores the native session path for resume/fork/rollback. It terminalizes at `agent_settled` plus an idle probe, not `agent_end`. Dialogs become T3 requests, notifications become activity items during an active turn, and terminal decoration is ignored. [T1][T8]

T3 injects an extension that registers namespaced MCP tools and appends orchestration guidance. Its `tool_call` hook implements supervised/auto-accept/full-access modes. MCP credentials are bound to a concrete T3 thread/provider session and revoked with that session; they are not transferable child identity. T3's own Pi launch projection explicitly removes inherited endpoint/token variables before injecting fresh credentials. [T8][T10][T11]

## 2. What your package adds—and where integration breaks

| Concern | Your package | T3 delegation/observation |
| --- | --- | --- |
| Execution owner | Parent Pi extension manages persistent RPC subprocesses | T3 owns delegated threads; adapters observe native work |
| Child identity | Reusable child ID + saved Pi session + separate assignment ID | Delegated task + child thread/run; Pi example observation has no child thread |
| Composition | Exact model/thinking, tools, resources, context, cwd roots, explicit MCP grants | Delegation exposes target/options and modes, not your composition schema |
| Follow-ups | Same child via `subagent_send`; explicit resume after shutdown | New delegated task per review round; ordinary thread messaging is separate |
| Local collaboration | Explicit peer links, budgets, holds; bounded DAG/check/repair workflows | Shared task lifecycle and cross-harness execution; no equivalent peer/composition contract in `delegate_task` |
| Human supervision | Halt/Kill persist holds; release starts nothing | T3 Stop/interrupt/task cancellation; not equivalent to a package hold |

Sources: [L1][L3][L4][L5][L6][T4][T5][T6].

### P0: Idle parent wake-up conflicts with T3 turn ownership

Package `index.ts` sends `subagent-report` with `triggerTurn: true`. `NoticeScheduler` waits for idle and batches after 100 ms; a later child result can therefore start a new Pi run after T3 already finalized its turn. T3 handles `agent_start` with no active turn by setting an error and terminating the connection:

> Pi started agent work outside an active T3 turn. The session was stopped to prevent invisible tool execution.

T3 has a specific test for this behavior. This is a concrete incompatibility in the inspected designs; exact timing determines whether a particular report triggers it. It also affects restored unread reports at session startup. Merely formatting reports as `details.results` does not fix turn ownership. [L1] (`session_start`/report delivery), [L2] (`NoticeScheduler`), [T1] (`handleSessionEvent`), [T3] (unsolicited-work test).

### P0: Parent credentials are inherited, parent approval enforcement is not

`manager.start` copies `process.env` and removes Pi session/model variables, but not `T3_MCP_URL`, `T3_MCP_BEARER_TOKEN`, or `T3_PI_RUNTIME_MODE`. Workflow `bash` checks also inherit the environment. At the same time, compiled children use `--no-extensions` plus explicitly selected resources and the mandatory guard, so the T3-injected permission hook is not normally loaded. [L3] (`start`), [L4] (`compile`), [L5] (`runCommand`).

This does **not** prove every child can invoke T3: the current read-only child has no MCP grant or shell, and the guard enforces selected tools. It does mean a permitted shell/trusted extension can access a credential identifying the **parent**, and the package does not automatically preserve T3's child approval ceiling. Approving a parent spawn is not evidence that every child tool is supervised. An inherited runtime-mode string alone enforces nothing. [L4][L7][T8][T10]

The existing non-recursion rule blocks `subagent_*` tools. It should not be mistaken for a universal prohibition on T3's namespaced `delegate_task`, ordinary thread tools, or shell-based recursion if those capabilities were explicitly granted. Keep T3 management authority out of native workers unless a separately designed scoped grant authorizes it. [L4][L7][T5]

### P1: Missing visibility also means missing known-work accounting

Your package has reliable local assignment/report state, but T3 only receives its ordinary tool results. T3's nested completion logic can only wait for work represented in its projection. A T3-owned Pi child that launches package workers and then finishes its parent turn can therefore appear finished before its hidden native work is accounted for. Source-derived risk: the package's delayed report could subsequently hit the idle-start rejection too. [L1][T2][T7]

Do not fix this by renaming `subagent_spawn` to `subagent`. The existing example adapter treats tool completion as child completion and derives identity from the call/step. Your spawn tool returns **acceptance**, while the reusable worker continues later. That shortcut would create false completion and unstable identities across list/read/follow-up calls. [L1][T2]

### P1: UI, stop, and recovery have different meanings

- `setStatus`, widgets, footer renderers, and the TUI inspector do not become T3 interfaces. T3 ignores those RPC decorations; `notify` is useful for active-turn feedback but is dropped when there is no active turn. [L1][L6][T1]
- Native child dialogs are stored in manager `uiRequests`, not automatically forwarded as parent Pi dialogs. A bridge must attribute and forward human-required questions, then route the human answer to the original child request. Do not let the model silently approve them. [L3][L6][T1]
- T3 Stop can tear down the Pi process; graceful package shutdown stops children/workflows. A simple parent abort and a process restart are different, and native subprocesses are not automatically T3 child threads. Halt/Kill must preserve package human holds; cancellation alone must not manufacture a hold-release authorization. Crashes may orphan subprocesses. [L1] (`session_shutdown`), [L3][L6], [T1] (`interruptTurn`).
- Reconnect should retain the same native parent Pi session ID, because package state is keyed by that ID. A fork/new session must not accidentally share a manager registry or control a live worker owned by another parent. Saved children restore stopped and require explicit, revalidated resume. [L3][L6][T1]

## 3. Integration roadmap

Everything in this section is a **proposal**, not an existing interface.

### Phase A — Safe coexistence, package-side changes first

1. Introduce a small **host-reporting interface** with two adapters: current standalone Pi delivery, and externally managed/T3 delivery. Explicit host negotiation is preferable; the nonsecret T3 runtime hint can support a conservative compatibility fallback, not authentication. In T3 mode, never start an idle parent locally. Preserve unread notices; passive UI publication must not count as parent-result consumption. Without a negotiated host wake path, defer results to an explicit read/next owned turn.
2. Strip T3 endpoint/bearer credentials from native child and workflow-command environments by default. Do not forward the cached injected extension or auto-import T3 MCP configuration. Preserve normal Pi provider authentication behavior; this change is about T3 control identity, not claiming credential isolation.
3. Define the effective child permission ceiling. Either enforce T3 restrictions through the mandatory child guard with human dialog forwarding, or initially refuse native capabilities that cannot preserve supervised behavior. Do not describe the current child policy as equivalent to T3 approval modes.
4. Document a conservative existing-use pattern: when native work must finish within a T3 turn, explicitly wait/read results before the parent finishes. This is a workaround for bounded work, not a background integration or guarantee against restored unread notices.

This phase can prevent the likely lifecycle failure without pretending that T3 already displays/manages your workers. Reporting, permission, and transport adapters should be private seams, not another large model-facing tool surface. [L1][L2][L3][L7]

### Phase B — Native worker visibility and human controls, changes on both sides

Agree a versioned envelope between the package and T3's Pi adapter. Suggested fields:

```text
schemaVersion, parentPiSessionId, sequence,
childId, assignmentId, originatingToolCallId,
workflowId/step/attempt (optional),
processState, assignmentState, activity,
resultCursor, resultPreview, reportedUsage,
humanHold, pendingUiRequestRefs, sessionRef
```

Keep **worker identity**, **assignment identity**, **process state**, **result-review state**, and **human hold** separate. Include snapshot/replay semantics, bounded previews, gaps, and late-event fencing. Exclude bearer tokens, hidden thinking, unbounded tool arguments, and sensitive log contents by default.

A plausible supported carrier is `pi.appendEntry("subagents.lifecycle.v1", data)`: custom state stays out of model context and emits `entry_appended` in current Pi RPC. T3 would need to consume that envelope, reconstruct a snapshot on reconnect, and continue ingesting late events. It does not do this today; emitting an arbitrary new JSONL record directly on stdout is not a supported shortcut. Validate the carrier on Pi 0.99.2 and current bundled/Node hosts. [P1][P2]

The T3 adapter should:

- Project package assignments as `provider_native` subagents, keyed by stable worker/assignment identity rather than each poll's tool-call ID. Start with `childThreadId: null`; do not invent a separately executing T3 thread.
- Track running native assignments/workflows before parent settlement so T3's known-work logic can see them. Keep event subscriptions alive for their late terminal events and handle idle entries too. [T7]
- Offer result notifications through an authenticated, persisted **T3-owned wake**. Never use a native worker's copied parent token, a raw local `triggerTurn`, or a forged delegated completion. Reconcile report keys/cursors before acknowledging; model consumption, UI observation, and task publication are different receipts.
- Expose attributed child dialogs and package-native human Halt/Kill controls. Existing `/subagents halt|kill` commands are a starting command path; a dedicated host interface would be clearer. Human actions must remain human-originated, with stop-requested versus confirmed-exit visible. [L1][L3]
- Keep child session inspection read-only initially. Opening a package session in another active harness without transferring ownership risks two writers/controllers. A session path is not sufficient authorization or an ownership handoff.

This is the best fit if the goal is: **“Use my rich Pi collaborators normally, but see and supervise them from T3 desktop/mobile.”**

### Phase C — Optional T3-owned workflow task executor

`WorkflowHost` already separates workflow scheduling from execution through `authorize`, `agents`, and `command`. That is a real seam for a second adapter, rather than branching T3 behavior throughout `SubagentManager`. Start with independent one-shot agent steps; keep artifacts, checks, attempts, and acceptance owned by the existing workflow module. [L5]

A T3 adapter could resolve a target through live capabilities, delegate with a stable request key per logical step attempt, retain returned task/thread/run IDs, consume terminal results, and route cancellation to the owning T3 task. On supported Pi versions, use the registered tool pipeline (`ctx.executeTool`) rather than reading the bearer token and inventing a second HTTP client. Feature-detect the tool and interface; registered names may use hyphens or harness-normalized underscores, and the current injected bridge returns text plus metadata, not a guaranteed structured output schema. [P1][T8]

Important restrictions:

- `delegate_task` has **no** selected-tools/resources/context/MCP/cwd composition fields. Thus it cannot enforce the current worker composition contract without upstream support or a separate trusted Pi launcher/guard arrangement. Prompt instructions are not an enforcement substitute. Fail closed on unsupported requirements; a distinct backend/policy is safer than silently weakening `subagents.json`. [T6][L4]
- Model mapping is explicit: a Pi `provider/model:thinking` becomes a T3 Pi instance + `provider/model` + advertised `thinking` option, only when that exact selection is available and authorized. A T3 `grok` CLI instance is not the same execution environment as Pi's `xai/...` provider. Never union catalogs as permissions. [T5][T6][L4]
- T3's catalog is capability discovery, not your allowlist. Add explicit authorization for remote targets; absence from the local policy must not become automatic permission to delegate remotely.
- Stable `clientRequestId` keys are scoped by T3's request namespace. Persist receipts and reconcile after a session/credential restart; do not claim global exactly-once execution from a repeated string. Timeout/lost response is not permission to launch a replacement task. [T6]
- Persistent `subagent_send` semantics, selected peer messaging, and local live-process limits are not preserved automatically. Reject peer groups initially and define separate remote task concurrency/capacity.
- Workflow dispatch outside an active parent T3 run cannot assume `delegate_task` remains callable: delegation explicitly requires a live parent owner. A fully background workflow executor needs a negotiated orchestration context, or must run under an explicit active orchestration turn. [T5]
- Choose one result-notification owner. T3's automatic wake and the package's automatic wake must not both publish/consume the same result.
- Do not use ordinary top-level thread launch as a substitute for delegation or as an unrequested worktree loophole. Delegated tasks share the parent's checkout; isolated delegated workspaces would need an explicit supported contract. [T5][T9]

This phase fits: **“Run some workflow steps on Codex/Grok/other T3 harnesses.”** It is not needed merely to display native Pi children.

## 4. Acceptance tests before calling this integrated

Use deterministic providers and a fake/real-local T3 transport; no live inference required for these contracts.

1. A result arrives after parent T3 settlement: no unsolicited Pi `agent_start`, no terminated session, and exactly one reconciled host-owned wake when supported.
2. Parent reload/reconnect, unread result recovery, session fork, and late old-session events: no replayed assignment, duplicate owner, or lost human hold.
3. Spawn admission stays nonterminal until assignment settlement; a reusable idle worker is not counted as running work. Failure/aborted/held states remain distinguishable.
4. A T3-owned Pi task launches native work and finishes its turn: publication waits for known work and any required result follow-up.
5. Native child and deterministic-check environments do not receive T3 bearer/endpoint variables. T3 tools cannot be restored through dynamic activation, codemode, or an unauthorized MCP grant.
6. Supervised and auto-accept parent modes: child tools preserve the intended ceiling; human dialogs route to the correct worker and cannot be approved by model output.
7. Human Halt/Kill, T3 Stop, workflow cancellation, and crashes: show requested versus confirmed cessation; preserve holds; never automatically replace held work.
8. T3 backend: duplicate logical request, response loss, wait timeout, provider-session restart, and later task follow-ups do not cause untracked duplicate execution or overwrite a published result.
9. Same assignment appears once across progress/read/list updates; cursor gaps and truncated output are explicit. Usage is labelled Pi/provider-reported, not a guaranteed subscription bill.
10. Run supported-host/package checks plus the canonical `./scripts/check.sh` when implementation begins. Existing notification, policy-RPC, peer, and workflow-RPC fixtures provide a useful base; they do not currently establish T3 compatibility. [L6]

## 5. What about `durable-subagents`?

The separate experimental package moves execution to native Durable conversations, has operation IDs and a host-controlled passive report inbox, and is a useful reference for separating admission, tasks, and reports. However, its **Pi extension adapter** still automatically delivers reports and triggers parent follow-up inference. Switching backend therefore does not by itself fix the T3 idle-wake conflict. It also does not port the stable package's full workflow/resource/inspector contract. Treat it as another future host adapter, not the prerequisite for this integration. [L8]

## Sources

### T3 primary sources (pinned revision)

- [T1]: [PiAdapterV2.ts](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts) — capabilities (118–220), unsolicited-run intent (475–482), UI handling (1175–1320), agent-start rejection (1556–1567), settle (1782 onward), interruption (2476–2529).
- [T2]: [Pi example-subagent projection](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L1026-L1129) — exact tool-name/result-shape recognition and completion mapping.
- [T3]: [PiAdapterV2.test.ts](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.test.ts) — unsolicited-work test (463–485), official example result test (1107–1209).
- [T4]: [Shared subagent schema](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/packages/contracts/src/orchestrationV2.ts#L663-L704).
- [T5]: [Orchestrator MCP guide](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/docs/orchestration-v2/orchestrator-mcp-server.md) — architectural overview; version-sensitive details checked against code/tool descriptions.
- [T6]: [MCP schemas](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/packages/contracts/src/orchestratorMcp.ts) and [OrchestratorMcpService.ts](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/mcp/OrchestratorMcpService.ts) — `resolveRuntimeMode`, `stableCommandId`, `readTask`, `delegateTask`, `cancelTask`; [current tool definitions](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/mcp/toolkits/orchestrator/tools.ts).
- [T7]: [SubagentProjection.ts](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/SubagentProjection.ts) — `makeSubagentChildThread`, `delegatedTaskProgress`; [Orchestrator.ts](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Orchestrator.ts) — `finalizeAppOwnedSubagent`; [RunExecutionService.ts](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/RunExecutionService.ts#L951-L1159) — background/native tracking and stream lifetime.
- [T8]: [Injected Pi MCP extension](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Adapters/piT3McpExtensionSource.ts) and [Pi user guide](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/docs/user/providers-pi.md).
- [T9]: [T3 orchestration instructions](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/provider/T3OrchestrationInstructions.ts).
- [T10]: [McpSessionRegistry.ts](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/mcp/McpSessionRegistry.ts) — credential scope/liveness/revocation.
- [T11]: [Pi launch projection](https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Adapters/piT3McpInjection.ts#L251-L316) — remove inherited T3 credentials, inject per-session values.

### This repository

- [L1]: [Extension entry point](../packages/subagents/extensions/subagents/index.ts) — report delivery (85–124), composition/tools, human commands, shutdown.
- [L2]: [Notification scheduler](../packages/subagents/extensions/subagents/src/notifications.ts).
- [L3]: [Manager](../packages/subagents/extensions/subagents/src/manager.ts) — `spawn`, `start`, `event`, human interventions, persistence/shutdown.
- [L4]: [Policy compiler](../packages/subagents/extensions/subagents/src/policy.ts) — `catalog`, `compile`, `commandDirectory`.
- [L5]: [Workflow host](../packages/subagents/extensions/subagents/src/workflow-host.ts) — `WorkflowHost`, `managerWorkflowHost`, `runCommand`.
- [L6]: [Stable package README](../packages/subagents/README.md) — lifecycle, human holds, workflows, non-recursion, reports/UI, persistence/tests.
- [L7]: [Mandatory child guard](../packages/subagents/extensions/subagents/src/child-guard.ts) and [managed built-ins](../packages/subagents/extensions/subagents/src/managed-builtins.ts).
- [L8]: [Durable package README](../packages/durable-subagents/README.md) — Pi adapter automatic reports versus passive native host inbox; migration limits.

### Pi primary documentation

Read from the installed 1.0.3 distribution. Public links are convenient navigation, not immutable snapshots of that installation.

- [P1]: [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) — lifecycle, `sendMessage`, `appendEntry`, `ctx.executeTool`, mode-independent UI, nested execution.
- [P2]: [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [JSON events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md), [extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md), and [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md).
- [P3]: [Built-in MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) — registered servers, exposure, nested tool pipeline.

[L1]: ../packages/subagents/extensions/subagents/index.ts
[L2]: ../packages/subagents/extensions/subagents/src/notifications.ts
[L3]: ../packages/subagents/extensions/subagents/src/manager.ts
[L4]: ../packages/subagents/extensions/subagents/src/policy.ts
[L5]: ../packages/subagents/extensions/subagents/src/workflow-host.ts
[L6]: ../packages/subagents/README.md
[L7]: ../packages/subagents/extensions/subagents/src/child-guard.ts
[L8]: ../packages/durable-subagents/README.md
[T1]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts
[T2]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L1026-L1129
[T3]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.test.ts
[T4]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/packages/contracts/src/orchestrationV2.ts#L663-L704
[T5]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/docs/orchestration-v2/orchestrator-mcp-server.md
[T6]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/mcp/OrchestratorMcpService.ts
[T7]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/SubagentProjection.ts
[T8]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Adapters/piT3McpExtensionSource.ts
[T9]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/provider/T3OrchestrationInstructions.ts
[T10]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/mcp/McpSessionRegistry.ts
[T11]: https://github.com/pingdotgg/t3code/blob/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38/apps/server/src/orchestration-v2/Adapters/piT3McpInjection.ts#L251-L316
[P1]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
[P2]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
[P3]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md
