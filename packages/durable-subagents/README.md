# durable-subagents

Experimental standalone TypeScript library and host for persistent named collaborators on **Pi Durable 1.0.0**. Children execute as native Durable conversations and tasks, not `pi --mode rpc` subprocesses. The original [`subagents`](../subagents/README.md) package is unchanged.

The workspace package is `@daniel-ballance/durable-subagents` at `packages/durable-subagents`. Persisted workflow task and document identifiers keep their pre-rename namespace so existing prototype SQLite databases remain compatible.

This is a separate, deliberately smaller implementation. It is **not a stable Pi extension**: `pi install` and `/reload` do not expose this host, and existing Pi extensions, `subagents.json`, sessions, credentials, workflow definitions, and TUI features are not imported. The package is private and exports TypeScript source; the workspace uses `tsx` to run it.

## Requirements and local checks

- Node.js **22.19.0 or newer**, including the Node SQLite adapter
- Exact runtime dependencies: `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord`, all **1.0.0**
- Explicit host-supplied models/providers, tools, policy, base directory, and storage
- One cooperating process per SQLite database

Use the repository's [clean-clone and installation instructions](../../README.md). From the repository root, the package commands are:

```sh
npm run check --workspace @daniel-ballance/durable-subagents
npm run test --workspace @daniel-ballance/durable-subagents
npm run smoke --workspace @daniel-ballance/durable-subagents
```

The smoke path exercises spawn, send, wait, and SQLite reopen with retained identity and exactly one report, using an explicitly registered deterministic **faux provider**. It does not make a live-model request or load credentials. Test/smoke success establishes local behavior of the tested paths, not live-provider compatibility or agent task quality. The canonical repository-wide check remains `./scripts/check.sh`; focused package checks are not a substitute for it.

## Minimal host example

This is an offline example, with a real SQLite file and a scripted response. Save it as a TypeScript program inside this package directory and run it there using `node --import tsx example.ts`, so package dependencies resolve.

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels, fauxProvider, fauxAssistantMessage,
} from '@earendil-works/pi-ai';
import { openSqliteSubagents } from '@daniel-ballance/durable-subagents';

const directory = await mkdtemp(join(tmpdir(), 'durable-subagents-'));
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
const model = { provider: 'faux', model: 'faux-1', thinking: 'off' } as const;
const host = await openSqliteSubagents(join(directory, 'session.sqlite'), {
  models,
  baseDirectory: directory,
  policy: {
    allowedModels: [model],
    allowedTools: [],
    allowedRoots: [directory],
    maxAgents: 2,
    maxActiveAssignments: 4,
    maxPeerMessages: 0,
  },
});

try {
  await host.spawn({
    name: 'reviewer', model, cwd: directory, tools: [],
    operationId: 'spawn:reviewer',
  });
  faux.setResponses([fauxAssistantMessage('Scripted review complete')]);
  const delivery = await host.send({
    name: 'reviewer', message: 'Review this example',
    operationId: 'review:1',
  });
  console.log(await host.wait(delivery.taskId));
  console.log(await host.readReports());
} finally {
  await host.close();
  // Demo cleanup only. Keep the directory to reopen a persistent session.
  await rm(directory, { recursive: true, force: true });
}
```

To reopen, keep the database and use `openSqliteSubagents` again with compatible task code and the explicit current provider/tool/policy configuration. The host revalidates stored children before permitting recovery. Automatic compaction and provider retries are disabled in this first host; interrupted native execution can still recover. Long-context and production retry settings remain a future host integration step. `close()` suspends work; it does not record a human halt.

A real provider is a separate host integration step. Supply a deliberately configured `Models` registry and any credentials through the provider's own supported setup. This package does not discover providers, read Pi authentication files, log in, or make that setup on the user's behalf.

## Host API

Import `DurableSubagents`, `openSqliteSubagents`, policy helpers, and workflow validation from the package root. The class and opener expose the following working surface; see [source](src/runtime.ts) for full types. Host methods accept an optional final Chord `Context` unless noted.

| API | Meaning |
| --- | --- |
| `DurableSubagents.open(options)` | Open on an explicitly supplied native `Storage`; the caller supplies exclusive ownership and storage lifecycle discipline |
| `openSqliteSubagents(path, options)` | Open SQLite with this package's fail-closed advisory owner lock; `options` omits `storage` |
| `spawn({ name, model, cwd, tools?, operationId })` | Create an idle, reusable named child; omitted tools means no tools |
| `send({ name, message, operationId, mode? })` | Admit a delivery task and return `{ operationId, taskId }`; default mode is `followUp`, alternatively `steer` |
| `wait(taskId)` | Wait for that delivery's `{ status, output?, answer?, reason? }`, where status is `completed`, `failed`, or `aborted` |
| `list()` | Inspect children, native usage, peer allowances, and unread report count without acknowledging reports |
| `readReports({ after?, limit?, acknowledge? })` | Read a bounded page, with cursor and possible retention gap |
| `connect(a, b, limit)` / `disconnect(a, b)` | Enable/disable an explicit bidirectional peer link |
| `renew(from, to, allowance, operationId)` | Explicitly reset one directional peer budget |
| `halt(name, operationId, reason?)` | Persist a human hold, then cooperatively drain current/queued child work |
| `release(name)` | Clear a confirmed human hold; start no work |
| `child(name)` / `state()` | Read application identity/control state |
| `close()` | Cooperatively suspend the harness and close storage; the SQLite wrapper then removes its owner lock |

`peerSend(callerConversationId, { recipient, message, operationId })` is the adapter used by the native `peer_send` tool. Its caller ID must come from trusted execution context, never from model-supplied identity. Use parent `send` for host-directed assignments.

The `harness`, `root`, and `workflows` properties exist for **trusted host integration**. Native conversation handles and direct transactions are powerful and can bypass the service's policy/holds if misused. Do not expose them, internal methods, or the `send` transaction guard to an untrusted model, network client, or arbitrary extension. They are not an additional authorized model surface.

### Identity, admission, and completion

- Names are unique within the session: 1–64 letters/digits/`_`/`-`, starting with a letter; reserved object-property names are rejected
- Use a stable logical `operationId` for spawn, send, peer sends, renewal, and halt. Reuse it only for the same operation and payload. Reuse with changed content is rejected; use a new ID for intentionally new work
- Ordinary operation IDs use 1–160 simple identifier characters. Peer IDs are internally namespaced, so keep the supplied peer ID short enough for the resulting ID to fit
- A send receipt means durable admission, not completion or human review. `wait` settles the particular delivery; `list` reporting `idle` does not prove an assignment succeeded
- `followUp` queues behind busy work; `steer` enters at a native turn/tool-round boundary, not halfway through arbitrary tool execution
- Repeated sends reuse the same conversation and its transcript. Spawn does not copy the parent's transcript
- `maxAgents` counts retained named children, including idle ones; there is no child-removal API. `maxActiveAssignments` counts nonterminal delivery tasks, including queued and reporting work. It is not a provider-wide rate/cost limit

The built-in root management tools are `subagent_spawn`, `subagent_send`, `subagent_list`, `subagent_read`, `subagent_connect`, `subagent_disconnect`, and `subagent_renew`. Children cannot select those tools or other reserved management names. Human halt/release and workflow supervision are host APIs, not child tools. The library installs the root tool surface but does not run a parent chat client or configure a parent model for you.

### Reports and read receipts

A finished delivery atomically settles its task, records its answer receipt, appends a passive result entry to the parent conversation, and adds a report to the application inbox. Multiple steers sharing one answer do not produce duplicate result reports for that answer.

Reports **do not automatically trigger parent follow-up inference**. A host decides when to display or consume them. The inbox retains the latest **200** result/intervention items; returned output excerpts are at most **16,000 characters**. Result and intervention entries remain in native history after inbox eviction. Current holds also remain visible in `list()` independently of inbox retention; the bounded inbox itself is not a complete audit log.

`readReports()` defaults to the saved unread cursor and acknowledges only the returned page (20 items by default). `acknowledge: false` inspects without moving the cursor. An explicit `after` is a replay cursor and never advances the saved read cursor, even with `acknowledge: true`. The return value is `{ reports, gap, next }`; `gap` warns that retention has removed earlier items. `list()` and `wait()` do not acknowledge reports. Acknowledgment records a read through this API, not proof that a human saw or accepted the work.

### Peer collaboration

Both children must explicitly select `peer_send`, policy must allow it with a positive ceiling, and the parent must connect that exact pair. Links are non-transitive. The tool binds sender identity to its native conversation context and labels the envelope as delegated work output, never human authorization.

Each direction has independent durable allowance. The allowance debit and delivery admission share one transaction; an exact retry does not spend it twice. Reconnecting re-enables an edge but does not refill or change its original budget. `renew` is an explicit directional reset. Disconnection fences future admissions; already admitted deliveries may finish. A lower current policy ceiling constrains persisted allowances after reopen.

There is no automatic refund or separate model-read/handled acknowledgment protocol. Use the returned delivery task's outcome to distinguish acceptance from completion.

## Explicit policy and tool trust

Policy has only these fields:

```ts
{
  allowedModels: [{ provider: 'faux', model: 'faux-1', thinking: 'off' }],
  allowedTools: ['peer_send'],
  allowedRoots: ['/absolute/project'],
  maxAgents: 4,
  maxActiveAssignments: 8,
  maxPeerMessages: 2,
}
```

Omitted fields grant empty lists or zero capacity. Model policy choices can also use the exact string `provider/model:thinking`. Child requests use the explicit model object. Provider, model, and thinking must match an allowed selection and exist in the host's model registry. Roots and child working directories are checked through real paths; `baseDirectory` and child `cwd` must be absolute existing directories. Relative allowed roots resolve against the explicit base directory.

Unknown fields are errors. In particular, legacy resource selection, extensions, skills, MCP inheritance, authentication, discovery, and stable Pi policy fields are not accepted or silently ignored. There is no ambient extension/tool discovery. The host supplies every non-peer tool implementation explicitly; children get only their selected names. Dynamic tool expansion is rejected.

This is **composition control, not an OS sandbox**. A permitted working directory does not confine arbitrary JavaScript, shell, provider, or tool code. Injected providers, tools, and execution environments are trusted host code. They must enforce their own filesystem/network/credential boundaries and honor cancellation.

Tool replay is unsafe by default upstream. Declare `replay: 'safe'` only for operations that are actually safe to repeat, normally through idempotency keys or reconciliation. Durable admission deduplication does not make external side effects exactly once, and an unsafe replay setting does not prevent a model from issuing a fresh duplicate call.

## Human supervision and storage recovery

`halt` commits a persistent hold before cancellation. New assignments, peer participation, tool execution, and recovery cannot pass that hold. The method then waits for cooperative cancellation and records confirmation. `release` rejects an unconfirmed hold, clears a confirmed hold, and starts nothing. Repeating an old halt operation after release does not stop newer work.

This runtime has **no forced per-child Kill**. All children share the host process; uncooperative provider/tool code can keep `halt` or `close` waiting. Add a separate process/worker/remote execution boundary if hard termination is required. Do not equate a requested hold with confirmed cessation of external effects.

The SQLite opener uses an exclusive `<database>.lock` directory, canonicalizes existing symlink aliases, and rejects dangling aliases, hard-linked databases, and non-regular or multi-linked SQLite files. It creates/restricts the database and existing WAL/SHM sidecars to mode `0600` before SQLite opens; newly created parent/lock directories use `0700`. This is advisory ownership: every cooperating host must use the opener, and raw SQLite clients can bypass it. A crashed process may leave a stale lock. There is no timeout, PID-only decision, or automatic takeover. An operator must verify that the previous owner really is gone, then remove that specific stale lock directory before reopening. Do not remove a lock merely because a request is slow.

The pinned SQLite adapter uses WAL with `synchronous=NORMAL`. Process-restart recovery is not a guarantee that the newest acknowledged commit survives sudden power/host loss. The host still owns supervision, persistent storage, backups, authorization, and safe recovery operations.

## Native workflows

`host.workflows` is a factory-produced native API already installed in the host registry. It supports a conservative static DAG of existing named agents and explicit approval steps:

```ts
import { BACKGROUND_CONTEXT as C } from '@earendil-works/chord/context';

const workflowId = await host.workflows.startWorkflow(host.root, {
  version: 1,
  name: 'Review',
  limits: { concurrency: 2, maxAttempts: 4 },
  steps: [
    { id: 'draft', kind: 'task', agent: 'reviewer', instructions: 'Draft a review' },
    { id: 'approval', kind: 'approval', instructions: 'Human reviews the draft',
      dependsOn: ['draft'] },
  ],
}, 'workflow:review:1', C);

host.harness.resume(); // Starting a workflow alone does not enable scheduling.
const view = await host.workflows.inspectWorkflow(host.harness, workflowId, C);
// When the approval node is ready and the human has approved:
// await host.workflows.approveWorkflow(host.root, workflowId, 'approval', C);
// await host.harness.waitForTask(workflowId, C);
```

The factory API requires explicit arguments and context:

- `startWorkflow(root, definition, operationId, context)` deduplicates an exact validated definition
- `inspectWorkflow(harness, workflowId, context)` returns native status/outcomes, node attempts, phase, and control state
- `approveWorkflow(root, workflowId, nodeId, context)` records approval for an already-ready approval node
- `retryWorkflow(root, workflowId, nodeId, context)` authorizes one further attempt of an unsuccessful settled node, preserving successful dependencies
- `holdWorkflow(root, workflowId, context)` fences new dispatch; already admitted deliveries may finish
- `releaseWorkflow(root, workflowId, context)` removes the hold but leaves `resumeRequired`
- `resumeWorkflow(root, workflowId, context)` explicitly permits dispatch after release or a blocked-agent intervention; scheduling must also be enabled on the harness

Workflows join each admitted batch with native `allSettled` dependencies before dispatching the next batch. Concurrency is batch/node concurrency, not rolling utilization or a global provider semaphore. Every node attempt, including approvals, consumes `maxAttempts`; exhausted attempts terminate the workflow. Failed nodes are not automatically retried. A hold does not revoke a previously recorded approval, and releasing a child hold does not automatically release/resume a workflow that blocked on it. Workflow cancellation does not itself cancel independently owned deliveries; use child supervision for that purpose.

The strict schema accepts only `version`, `name`, `limits`, and task/approval steps with optional dependencies. It rejects cycles, missing/duplicate IDs, unknown fields, and impossible attempt budgets. Legacy command/agent checks, artifact snapshots/digests, deadlines, repair/improvement loops, peer groups, worker composition, and workflow TUI are **not ported**. There is no stable-workflow importer or compatibility claim.

## Architecture and migration boundary

[ARCHITECTURE.md](ARCHITECTURE.md) describes ownership, transactions, recovery, what this implementation replaces, and what remains to be ported before considering retirement of the original backend.
