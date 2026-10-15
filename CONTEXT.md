# Pi Packages

A collection of Pi packages that extend the harness with capabilities it does not
ship: persistent child agents, bounded workflow scheduling, peer messaging between
children, MCP protocol integration, web search, and self-reload. Each package
lives under `packages/`.

## Language

### Structure

**Package**:
A directory of Pi resources (extensions, skills, prompts, themes) declared through
a `pi` manifest and loaded as one unit.
_Avoid_: plugin, bundle, module

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
The policy ceiling in `subagents.json` declaring what a Parent may compose. Highest
priority existing file wins as a whole-file replacement; nothing merges.
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
depth 1. The policy's `maxDepth` (default 1) bounds it. A Child above the deepest
level may be given proxied delegation tools: it then composes Children of its own,
but only through the one root Manager, only from the same Allowlist, and acts only
on its own subtree.
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
A node in the Run's DAG. Either a Task or a Check.
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
A Child bound to one Task by the workflow runtime. Closed when its Task or group
finishes. Workers are not persistent orchestrators.
_Avoid_: agent, executor, subagent

**Candidate directory**:
The fresh directory a Worker is given to write into. Source and evaluators are read
only to the Worker; artifacts are the only thing that flows onward.
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
What launched Pi: a terminal (`cli`) or T3 Code (`t3`, detected by `T3_MCP_URL`).
Packages ask the shared host helper, never the environment directly.
_Avoid_: mode (Pi's `--mode rpc` is a transport; T3 also runs Pi over RPC), platform

**Contract**:
The host-neutral capability a skill is written against: delegate, wait, cancel,
isolate in a worktree, wake, ask the human, track a todo. Skills name contracts and
resolve them through one lookup reference, never a backend tool name inline.
_Avoid_: interface, API

**Backend**:
The host-native tool that satisfies a Contract on one Host, such as `subagent_spawn`
in a terminal or T3's `delegate_task` under T3. Each Contract has one Backend per
Host; a gap on one Host is stated in the skill, not papered over.
_Avoid_: adapter, driver, provider (Pi uses that word for model providers)

**Duplicated primitive**:
A tool whose Contract T3 already satisfies natively. Under T3 it is registered with
`deferred` exposure: reachable through tool search and codemode, absent from the
prompt. Under the CLI it is registered as usual.
_Avoid_: hidden, disabled (both mean unreachable, which deferred is not)

**Role default**:
The model, with thinking level, that one pistack role uses unless the skill or the
human says otherwise, kept in `pistack.json`. A hint for choosing a Composition's
model, not a Composition: tools, resources and directories are still chosen per
Child, and the Allowlist still bounds the model.
_Avoid_: profile, preset (see Composition)

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
  say **Parent** or **Child**. "Agent" appears only in the tool namespace
  (`subagent_*`) and in package descriptions.
- **"subagent"** was used both for the running process and for the package/tool
  prefix. Resolved: the running thing is a **Child**; `subagent` is namespace only.
- **"worker"** was used for any Child doing anything. Resolved: **Worker** only
  inside a workflow Run. A manually spawned Child is a Child.
- **"profile" / "role"** were considered and rejected. Composing a fixed profile
  caps what the Parent can build. The concept is **Composition**, chosen per Child.
  pistack's **Role default** is narrower: a model hint per role, never a whole
  Composition.
- **"done"** conflated three different facts. Resolved: **Settled** (turn ended),
  **Accepted** (RPC queued), **Validated** (a Check passed). Say which one.
