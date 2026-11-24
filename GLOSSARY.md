# p3stack

The repository root is one Pi package. It loads six packages: claude-subscription,
p3stack, computer-use, self-reload, web-search, and t3-agent. p3stack owns the router, the
generated workflows, and its nested subagents and todo components. Each package keeps
its own tests. `packages/mcp-client/` stays a separate optional replacement for native MCP.

## Language

### Structure

**Package**:
A directory of Pi resources loaded as one unit. Packages in this repository list
their resources in a `pi` manifest. Pi also supports discovery by directory convention.
_Avoid_: plugin, bundle, module

**Root package**:
The repository root as one Package. `scripts/root-package.mjs` generates its `pi`
manifest from the Packages that `package.json#piBundle` lists, so one install loads all of them.

**Parent**:
The Pi session that composes, supervises and reads the results of Children.
_Avoid_: orchestrator, controller, driver, main agent

**Child**:
A persistent Pi RPC process composed explicitly by the Parent, or within
`maxDepth` by another Child, and tracked by the one root Manager. It survives turns,
keeps its own context, and is resumable.
_Avoid_: subagent (that is the package and tool namespace, not the running thing),
worker (workflows only), agent (ambiguous)

**Manager**:
The parent-owned component that owns Child lifecycles, the peer graph, accounting
and recovery. It lives inside the Parent process, not as a separate daemon.
_Avoid_: supervisor, broker, scheduler (the workflow scheduler is a distinct thing)

**Composition**:
The explicit set of model, thinking level, tools, resources, working directories
and prompt instructions granted to one Child. Every field is chosen per Child.
_Avoid_: profile, role, preset, template (all of these are explicitly rejected:
a fixed profile is a ceiling on what the Parent can build)

**Allowlist**:
The policy ceiling on what a Parent may compose. The highest-priority applicable
`subagents.json` replaces the built-in policy as a whole.
_Avoid_: config, settings, permissions

**Catalog**:
What is actually usable right now: allowed models that are also authenticated,
tools that exist, resource files that resolve, directories that are permitted.
Distinct from the Allowlist, which is what was declared.
_Avoid_: inventory, list, registry

**Child guard**:
The mandatory extension in every Child that keeps its active tools to the ones its
composer selected and blocks every other tool at execution, `subagent_*` tools the
Child was not given included. No policy can disable it.
_Avoid_: sandbox, non-recursion guard (a Child may now delegate within `maxDepth`)

**Delegation depth**:
How far below the root Parent a Child sits; the root Parent's own Children have
depth 1. The built-in policy permits depth 2. A user policy that omits `maxDepth`
permits depth 1. A Child below the limit can delegate within its own subtree
through the [root Manager](docs/adr/0002-nesting-through-one-root-manager.md).
_Avoid_: recursion, nesting level, sub-agent of a sub-agent

### Lifecycle

**Spawn**:
Create a Child and hand it its first task. Returns acceptance, not completion.
_Avoid_: launch, start, fork

**Settle**:
A Child has finished its turn and is idle, with its context intact. The state the
Parent waits for.
_Avoid_: finish, complete, done (these imply the work was correct)

**Resume**:
Restart a stopped Child from its saved conversation and composition, revalidated
against the current allowlist.
_Avoid_: restart, reconnect

**Steer**:
Deliver a message to a working Child so Pi queues it at the next tool boundary.
_Avoid_: interrupt, inject

**Follow-up**:
Deliver a message to an idle Child, starting a new turn.
_Avoid_: send (direction-ambiguous; say steer or follow-up)

### Peer messaging

**Peer link**:
A Parent-authorized, bidirectional, non-transitive connection between two
Children. A↔B and B↔C never authorize A↔C.
_Avoid_: channel, bus, group, network

**Allowance**:
A directional message budget on a Peer link. Renewing replaces one generation with
the next and resets used; lifetime totals are retained.
_Avoid_: quota, limit (the policy ceiling is the `peerMessageLimit`, distinct)

**Envelope**:
The manager-generated attribution wrapped around a peer message body, marking it
as untrusted work output rather than user instruction or permission.
_Avoid_: header, wrapper, prefix

**Accepted**:
The RPC was queued for delivery. Says nothing about whether the model read,
understood, or answered it.
_Avoid_: delivered, received (a `received` marker means it entered the
conversation, which is still not proof of an answer)

### Workflows

**Workflow definition**:
JSON authored by the Parent describing steps, dependencies and limits. Validated
on start; unknown fields fail.
_Avoid_: pipeline, script, DSL (there deliberately is no executable DSL)

**Run**:
One execution of a Workflow definition, with its own ID, attempt count and
wall-clock deadline. One Run executes per Parent at a time.
_Avoid_: job, task (a Task is a step inside a Run)

**Step**:
A node in a Run's dependency graph: a Task, a Check, or a loop with a bounded worker-and-check body.
_Avoid_: stage, phase, node

**Task**:
A Step where a Worker produces an artifact into a supplied candidate directory.
Completion means an artifact was submitted, not that it is correct.
_Avoid_: job, unit of work

**Check**:
A Step that validates a predecessor's output via a deterministic validator, an
agent rubric, or a human.
_Avoid_: gate, review, assertion

**Worker**:
A Child assigned work by the workflow runtime. The runtime closes Workers when
their Task or group finishes, except Workers held for human supervision.
_Avoid_: agent, executor, subagent

**Candidate directory**:
The fresh directory for a Worker's output. Workers must write only there. This
rule does not make the source or evaluators read-only at the OS level.
_Avoid_: workspace, sandbox (it is not one)

**Attempt**:
One worker or check execution. Every worker and every check consumes one from the
Run's total, including baseline evaluations and human checkpoints.
_Avoid_: retry (a retry is an attempt, but the count is not retries)

**Human check**:
A validation only a person can decide, recorded through `/workflows approve|reject`.
There is deliberately no model-callable approval operation.
_Avoid_: manual gate, approval step

### Host parity

**Host**:
What launched Pi: a terminal (`cli`) or T3 Code (`t3`). The shared helper
identifies T3 by its nonempty `T3_MCP_URL`.
_Avoid_: mode (Pi's `--mode rpc` is a transport; T3 also runs Pi over RPC), platform

**Contract**:
The capability a skill asks for, such as delegating or asking the human.
_Avoid_: interface, API

**Host map**:
The [shared capability reference](packages/p3stack/extra/skills/poteto-mode/references/host-capabilities.md) and its two host-specific files. A skill reads the shared entry and follows only its own host's link for the operation or fallback.

**Backend**:
The host-native tool that satisfies a Contract on one Host, such as `subagent_spawn`
in a terminal or T3's `delegate_task` under T3. Some capabilities lack a
backend on one host.
_Avoid_: adapter, driver, provider (Pi uses that word for model providers)

**Duplicated primitive**:
A package tool whose capability T3 also supplies. Native subagents registers no delegation tools under T3, whereas `todo` stays direct on both hosts.
_Avoid_: hidden, disabled (both mean unreachable, which deferred is not)

**Loadout**:
The tools t3-agent activates for a session, based on the chosen preset and open Handles. It tracks its own additions separately from the bridge's active tools.
_Avoid_: toolset, profile

**Handle**:
A T3 object identified in a tool result, such as a delegated task, schedule, watched pull request, thread, preview tab, or device. A recorded tab is not necessarily the caller's to close.
_Avoid_: resource (Pi uses that word for skills, prompts and themes), task (one kind of Handle)

**Role default**:
The model and thinking level requested for a p3stack role, from a role file or a built-in hint. It guides model selection, not the whole Composition, and remains subject to the host's catalog.
_Avoid_: profile, preset (see Composition)

### Routing

**Route**:
A row that matches the requested deliverable and Grant to a first read or an inline action.
_Avoid_: mapping, dispatch

**Skill reference**:
A procedure read through its owning skill rather than invoked as a command. A Route or Chain can select the reference directly.

**Chain**:
A conditional read that the generator inserts before or after a named playbook step. The model follows the **p3stack only** instruction when its condition holds.
_Avoid_: hook, step (the playbook's own numbered items are steps)

**Grant**:
Who decides covered product choices: the human under `default`, or the agent under `full-autonomy`, with operator gates intact. An explicit request can raise the Grant for one task without changing the session branch's saved Grant.
_Avoid_: mode (the mode is on or off), autonomy level

**Brief**:
A parent's instructions for one delegated assignment, including scope, limits, and the evidence to return. The [brief header](docs/adr/0006-mechanical-procedures-become-tools.md) carries the saved Grant; the parent states any task-only increase in the brief itself.

**House policy**:
One of the router's numbered rules that takes precedence over a routed skill, for example the rule that a review ends at a report.

**Floor**:
The part of the quality bar that holds with no setup and under every Grant: no new
suppressions, skipped or deleted tests, stubs, swallowed errors, or weakened
thresholds. `floor-check.mjs` checks it; `floor-ok: <reason>` explains a line.
_Avoid_: quality gate (that is a project's whole `CONSTRAINTS.md` bar)

**Ledger**:
The [execution ledger](packages/p3stack/skills/p3stack-mode/references/execution-ledger.md) is the coordinator's private, append-only record of attempts, checkouts, commit IDs, evidence, and pending gates for a long-running unit or multi-unit plan. The T3 handle ledger instead records the last observed state of Handles on a session branch.
_Avoid_: decision trail (that is the audit record `show-me-your-work` keeps)

**Description lint**:
An offline vocabulary check that ranks example prompts against the names and descriptions of model-invoked skills. A passing rank is not an observed routing decision.

**Interactive prototype**:
A prototype a human tries and judges: a single shareable HTML file around a
liftable pure module, or UI variants on the real route on a `prototype/<name>`
branch. The Prototype playbook's other branch is judged by the agent observing it.

**Watch-only source**:
A vendored upstream that ships only its license. Every skill row is a drop, and
`rules/borrowed.json` names the p3stack files that restate its ideas, so a bump
flags changes to those ideas for review.

### Boundaries

**Not a sandbox**:
The standing fact across every capability here. Candidate directories, digest
checks, tool allowlists and envelopes are policy and accounting, not OS isolation.
Unrestricted `bash` and trusted extensions retain full host privileges.
_Avoid_: sandbox, jail, isolation

**Untrusted work output**:
The status of anything a Child or peer produced, including its own assistant text.
Never a source of instructions or permissions for the Parent.
_Avoid_: results, findings (use those for what the Parent has verified)

## Flagged ambiguities

- **"agent"** was used loosely for the Parent, a Child, and Pi itself. Resolved:
  prefer **Parent** or **Child** when the distinction matters.
- **"subagent"** was used both for the running process and for the package/tool
  prefix. Resolved: the running thing is a **Child**; `subagent` is namespace only.
- **"worker"** was used for any Child doing anything. Resolved: **Worker** only
  inside a workflow Run. A manually spawned Child is a Child.
- **"profile" / "role"** were considered and rejected. Composing a fixed profile
  caps what the Parent can build. The concept is **Composition**, chosen per Child.
  p3stack's **Role default** is narrower: a model hint per role, never a whole
  Composition.
- **"done"** conflated three different facts. Resolved: **Settled** (turn ended),
  **Accepted** (RPC queued), **Validated** (a Check passed). Say which one.
