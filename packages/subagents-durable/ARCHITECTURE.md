# Native Durable architecture

This package is a new implementation on the pinned **Pi Durable / pi-ai / Chord 1.0.0** stack. It is a standalone host, not a wrapper around the existing RPC children and not a stable Pi extension. [`packages/subagents`](../subagents/README.md) remains intact. The native package is experimental and intentionally lacks parts of the original product surface.

## Runtime ownership

One trusted `DurableSubagents` host opens one native `Harness` over one storage backend. Its root conversation is the application parent. A registry installs the child tool definitions, parent management tools, Anchor and Delivery tasks, and workflow/node task definitions. Definitions are executable host code and must be available again on reopen; the database does not store executable definitions.

For each named child, one transaction creates a background Anchor task, a task-owned child conversation, explicit agent settings, and the name-to-conversation mapping. The anchor can complete while its background ownership boundary permits later child work to outlive an ordinary parent turn. A child's transcript persists across assignments; no parent-history fork is performed.

A send creates a root-owned background Delivery task. Its `deliver` phase admits native child input with the stable request ID `subagent:<delivery task ID>` and waits for the native Submission. Its `report` phase commits the final passive parent report and settles. The Delivery task is a durable continuation, not an in-memory promise used as a second queue. Native submissions own input queuing, placement, steering, and settlement.

The host is not a daemon or supervisor. The embedding application must restart the process and reopen persistent storage when required. `close()` suspends the runtime cooperatively; a saved human hold is a separate application decision.

## Application state retained deliberately

| Native state | Application purpose |
| --- | --- |
| `TeamDoc` | Named child identities and selected composition; human holds; directional peer allowances; last 200 report items; report sequence/read cursor |
| `OperationDoc` family | Fingerprint and receipt for a logical spawn/send/renew/halt operation |
| `ReportedAnswerDoc` family | Suppress duplicate result reports when multiple deliveries share one native answer |
| Passive result/intervention entries | Immutable parent-history records written atomically with report/control state; finished results also settle the Delivery task |
| `WorkflowControl` | Explicit hold/resume/approval/retry intent; execution status remains in native task records |
| `WorkflowStarts` | Workflow start-operation fingerprint and native task ID |
| Native task checkpoints/outcomes | Delivery phases, workflow batches/dependencies/attempts, and execution results |
| Native conversation documents | Agent selection, current generation/tools, input inbox, and usage |

Operation/answer receipts are retained rather than evicted with the display inbox: deleting them would weaken retry deduplication. The current workflow-start map is also retained. Storage/receipt growth and future schema migration need an explicit retention design; the 200-item inbox cap does not mean the whole session is bounded.

Both result and intervention notices have immutable native parent-history entries. Their last-200-item inbox is a consumption view, not the full archive. Current holds remain visible in the child state and `list()` independently of read acknowledgment or inbox eviction.

## Atomic boundaries and idempotency

Durable serializes transactional mutations through the native Session. The application uses that line rather than independently synchronizing JSON files and child transcripts.

1. **Spawn:** logical operation receipt, anchor, child conversation, configured composition, and named identity commit together
2. **Assignment admission:** logical operation receipt and background Delivery task commit together
3. **Peer admission:** directional allowance debit, operation receipt, and Delivery task commit together
4. **Child submission:** the native `requestId` deduplicates a delivery across restart before its application checkpoint is recorded
5. **Finished reporting:** report item, answer receipt, passive parent entry, and terminal Delivery task outcome commit together
6. **Workflow dispatch:** node creation and the workflow's waiting checkpoint commit together; a workflow-open guard runs in the same transaction as new service delivery admission
7. **Human supervision:** hold/release state, intervention inbox notice, and passive intervention entry commit together; halt intent commits before cooperative cancellation begins

`OperationDoc` fingerprints reject accidental reuse of a logical operation ID for different content. This adds a payload check that native input request-ID deduplication alone does not supply. Repeating a completed halt operation cannot cancel a new assignment after release. Repeating a renewal operation cannot refill a budget again.

These guarantees concern committed application/native admission, not all external effects. A model request may be issued again after interruption. A tool can affect a service and crash before recording the result. The embedding application must use real external idempotency or reconcile uncertain effects. A fresh operation ID is new work even if its text duplicates an earlier request.

Some APIs are deliberately not replay-safe mutations: report acknowledgment, connect/disconnect, human release, and workflow controls have their own state semantics rather than universal operation-ID receipts. The root tool registrations mark acknowledge/connect/disconnect unsafe. Do not build an indiscriminate retry wrapper around all host methods.

## Admission fences and supervision

A small in-process `AdmissionFence` orders the short check-and-submit intervals against human holds. It never waits for model inference or ordinary tool execution and is not a persistence or queue layer. Durable tasks/submissions remain the source of work state.

A child hold is persistent application policy. It blocks future sends, peer participation, wrapped tool execution, and recovery. `halt` first commits the hold, then aborts nonterminal delivery tasks, drains the child conversation including queued/background work, and only then marks the hold confirmed. Concurrent halts share cooperative cancellation; the cancellation is scoped to the held generation. `release` requires confirmed cessation and starts nothing.

On open, the host does not resume the scheduler immediately. It revalidates each unheld child's exact model/thinking, selected tools, and canonical working directory against current policy/provider/tool availability. A failed revalidation creates a persistent hold requiring human review. Tasks for held children are marked for native abort before progress APIs can enable scheduling, then held conversations are cooperatively drained. A committed tool intent cannot bypass current tool selection merely because upstream `beforeTool` hooks do not rerun on replay: the host wraps the actual execute function with a current-policy/hold check.

This remains cooperative JavaScript cancellation. A started external effect is not rolled back by a hold; a tool that ignores cancellation may block completion of `halt`, recovery, or `close`. There is no in-process equivalent of per-child SIGKILL. Hard termination and isolation require a separate execution boundary.

## Composition and trust boundary

Policy is a new, strict, deny-by-default schema. The host accepts exact model/thinking choices, selected tool names, canonical directory roots, retained-child capacity, active-delivery capacity, and peer ceilings. Empty or omitted grants permit nothing. Unsupported stable Pi fields are rejected instead of partially interpreted.

No ambient settings, auth files, provider catalog, extension search path, skills, context files, MCP servers, or credentials are discovered. Providers and non-peer tool code must be deliberately supplied by the trusted host. Selected native child tools are wrapped so policy is checked on actual execution, including safe replays. Reserved management tools cannot be granted to children, and dynamic tool additions are rejected.

The implementation trusts the host's tool/provider code. It cannot prevent an injected JavaScript tool from opening files, making network calls, reading environment secrets, invoking another model, or ignoring cancellation. Directory validation limits composition; it is not a sandbox. Providers, execution environments, credentials, and isolation remain host responsibilities.

`harness` and `root` expose native power for trusted embedding code. A raw conversation handle can submit outside the service's admission checks, and a direct transaction can alter application state. Those APIs must not be exposed as model tools or a public unauthenticated control plane. Model-facing authority is only the validated registered tool surface. Human halt/release and workflow approval/control calls require the embedding UI or host to establish the appropriate human authority.

## Peer routing without a private wire

`peer_send` derives caller identity from `api.conversationId`. It resolves a registered child, requires the tool to be selected, checks both participants against current policy/holds, and requires an explicitly enabled directed edge. The parent creates a pair of independent directed allowances with `connect`; there is no transitive reachability.

Budget reservation and durable delivery admission are one commit. The operation key is namespaced by sender; retries return the same task and spend no additional allowance. Reconnect does not reset an edge; renewal is explicit, directional, and deduplicated. Current policy can lower the effective ceiling of an older stored allowance.

Peer content is prefixed as delegated output rather than authorization. It enters idle recipients as input and busy recipients as native steering. A receipt identifies an admitted delivery; completion is the Delivery task outcome. This version does not reproduce the old private-wire `received`/`handled` status vocabulary, automatic refunds, or a semantic model-read acknowledgment.

## Passive reports and review semantics

Reporting intentionally differs from the upstream background-subagent example. The example submits a parent follow-up; this host appends a passive result entry and bounded inbox report instead. A child finishing does not automatically restart a parent model run.

Result-task settlement, answer deduplication, report history append, and inbox update share a commit, removing the old parent-history/registry acknowledgment repair window within this native session. This is a storage receipt, not evidence that a human read or accepted the result.

`list` and `wait` do not acknowledge. The default `readReports` cursor advances only through the returned page. Explicit `after` cursors replay without acknowledgment. Retention gaps are reported. The host is responsible for rendering, prioritization, notifications, further verification of results, and any eventual cross-runtime/client delivery receipt.

## Native workflows

The host installs the task definitions returned by `createWorkflowTask` and exposes the resulting factory API as `host.workflows`. A workflow references already-created named agents; it does not recreate legacy worker-composition logic.

The strict version-1 DSL is a static DAG with two node kinds: task and approval. Nodes join successful dependencies through native outcomes. A workflow dispatches a bounded batch, waits using `allSettled`, then evaluates the next batch. It uses native waiting/checkpoint states and document watches rather than a custom polling execution loop. Batch joins mean one slow or approval-blocked member delays the next batch even if another slot is free.

Each attempt has a native node task. Task nodes use a stable workflow/node/attempt operation ID for service delivery, so a crash after delivery admission but before the node checkpoint reuses the same work. Node tasks are workflow-owned, but service delivery tasks are separately root-owned background tasks. Cancelling an observer/workflow does not accidentally stop a later conversation turn; it also does not promise to cancel all in-flight deliveries.

A workflow hold is a dispatch barrier, not a child halt. It commits `held` and `resumeRequired`; an atomic guard prevents the preflight-to-admission race. Already admitted work may finish. Release clears `held` only; explicit resume is still necessary. Approval is available only after a node becomes ready. Retries target an unsuccessful settled node, leave successful dependency attempts untouched, and consume the original maximum-attempt budget. There are no automatic retries or automatic rollback/invalidation of successful downstream work.

If current child availability blocks preflight, the workflow records an intervention requiring explicit resume. A later admission failure becomes a failed attempt requiring an explicit named retry. Child release alone does not provide workflow resume consent.

Not implemented: command/agent checks, artifact snapshot/digest transfer, original deadlines, repair/improvement loops, dynamic graphs, peer groups, full legacy composition, cost budgets, or TUI workflow management. Unknown legacy fields fail validation. Native joins replace execution plumbing, not the omitted product semantics.

## SQLite operations and failure boundaries

`openSqliteSubagents` canonicalizes existing database aliases, rejects dangling symlinks and hard-linked databases, and atomically creates `<database>.lock` with an owner metadata file. Before opening SQLite it creates or restricts the main database to mode `0600`, and checks/restricts existing WAL/SHM sidecars to regular single-link files with mode `0600`. New sidecars inherit the database mode; newly created parent and lock directories use `0700`. Existing parent-directory permissions are not rewritten. A second cooperating opener fails closed. It does not infer abandonment from elapsed time, a stale PID, or an unavailable process. Clean `host.close()` closes the harness/storage and then removes the lock.

After a crash, an operator must establish that no previous process still owns the session before removing that exact lock directory. Keep the database and its SQLite state intact. A raw SQLite opener can ignore the advisory lock; this wrapper is not an OS-level prohibition on external clients. Direct `DurableSubagents.open` callers must provide equivalent exclusive ownership themselves.

The upstream Node SQLite adapter uses WAL and `synchronous=NORMAL`. Recovery from an application process interruption is different from surviving power loss: the newest acknowledged writes are not promised to survive sudden host/power failure. The package adds no stronger fsync contract, replication, automatic backup, supervisor, or high-availability takeover.

A harness close is suspension rather than permanent cancellation. Reopen reconciles native checkpoints/inputs after the application's recovery vetoes. Native progress operations such as wait/submit/resume can enable scheduling; merely opening a workflow through `startWorkflow` does not. Embedders must understand these lifecycle edges rather than using the raw harness as a policy-free escape hatch.

## What is replaced here, and what remains

This native package does not execute or depend on the original implementation's:

- `RpcChild`, per-child process spawn, JSONL decoder, stdin/stdout request maps, or RPC prompt acknowledgment
- FD 3 peer transport, frame decoder, socket timeout/pending map, or wire-supplied identity inference
- `registry.json` and workflow `run.json` execution-state stores
- Separate queued-assignment/execution ledger or parent-history-to-registry receipt repair
- RPC status/usage polling or event reconstruction to infer native task completion

Those functions are supplied here by native conversations, submissions, tasks, document transactions, native usage, and explicit task joins. This is actual native execution, not an RPC adapter hidden behind Durable tasks.

The original package's files are **not deleted**, and its full capabilities are **not reproduced**. Retained application value includes named identities, explicit composition, peer authorization/budgets, stable logical IDs, human holds, report read receipts, and a small workflow control layer. Broader workflow semantics, original inspector/footer/notifications, stable extension ports, live-provider setup, session migration, hard kill, and other UI remain outside this implementation.

Before retiring the original backend, establish required feature parity and a deliberate old-session archive/import/handoff path, test real provider/tool integrations and external-effect recovery, and satisfy the chosen process-isolation/storage-operating requirements. The architectural end state can be one native execution stack; retaining this separate prototype now is not a claim that migration is finished.

## Verification boundaries

The package's deterministic tests exercise native SQLite open/reopen, operation deduplication, report reads, queued continuation, holds/recovery, peer identity/budgets, safe/unsafe tool replay, strict policy, workflow dependency joins, approval/retry budgets, and dispatch holds. A subprocess test also exits abruptly after a local unsafe tool effect, verifies stale-lock refusal, and then verifies recovery without replaying that effect after operator-style lock cleanup. Consult [test sources](test/) and actual command results for the precise tested paths.

Scripted providers and graceful close/reopen exercises do not establish live inference quality, production credentials, arbitrary extension compatibility, non-cooperative hard kill, actual power-loss durability, or a complete crash-injection matrix. A hold-window test that writes the persisted state before reopen is a targeted recovery simulation, not proof that every possible OS/process fault was injected. The smoke command is also deliberately faux-provider-only.

## Pinned upstream references

The implementation is based on Pi Durable release commit [`a13d35a`](https://github.com/earendil-works/pi/commit/a13d35a742c6ef8462812a28fbe1d8c8b7431c32), not moving `main`:

- [Durable concepts and API](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/README.md)
- [Background subagent example](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/test/examples/23-subagent-background.ts)
- [Task, ownership, replay, submission, and storage specification](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/docs/spec.md)
- [Native tool replay implementation](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/tool.ts)
- [Node SQLite adapter](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/storage/sqlite/node.ts)
- [Experimental Durable TUI boundary](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/src/experimental/durable/README.md)
