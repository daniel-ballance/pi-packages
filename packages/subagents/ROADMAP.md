# Subagents: future directions

This records ideas deliberately deferred while building the persistent-child foundation. **It is not a release schedule.** Bounded point-to-point peer communication and a small workflow scheduler are now implemented; channels/shared boards, dynamic/nested workflow graphs, cross-parent communication and sandboxing are not. See the README for supported behavior; unresolved questions below are not settled API decisions.

See the [README](README.md) for the current behavior and policy contract.

## Principles to retain

- The parent composes children from allowlisted ingredients, rather than choosing mandatory predefined agent profiles.
- Policy remains explicit and fail-closed. New capabilities must not silently broaden existing configurations.
- Children manage other children only within bounds the policy grants (`maxDepth`, default 1: none). One root Manager owns the whole tree; a Child acts only on its own subtree, through proxied tools, and never edits policy, links peers outside its subtree, releases holds or decides human approvals. Communication must not grant spawn, resume, abort, close, policy-editing or approval authority.
- Agent messages are delegated work output, not user instructions or permission grants. Human-required approvals remain human decisions.
- Persistent conversations, observable lifecycle state, bounded output and reliable cleanup remain core requirements.
- Notifications should represent unread, actionable work rather than duplicate reports or routine chatter.
- Tool allowlists and working-directory restrictions must not be described as an OS-level sandbox. Unrestricted bash can bypass process-level conventions.

## Pi 0.99 built-ins

Implemented: explicit native codemode/tool-search/MCP grants, raw MCP tool matching, project-config and credential consent, provider/resource linkage, source-aware child checks, classifier disabling, virtual-model refusal, codemode settings and optional cache-warming suppression. Pi remains the only MCP transport/OAuth client.

Deferred: credential-free HTTP/OAuth store isolation, MCP resources/prompts, extension-registered MCP servers, classifier allowlists and virtual routing. These require verified public interception APIs, not source scanning or a second client. See the [built-in contract](skills/subagents/reference/builtins.md).

## 1. Inter-subagent communication

**Goal:** let cooperating children exchange questions, findings and handoffs without making the parent manually relay every message.

**Implemented foundation:** parent-controlled bidirectional, non-transitive links; child-only `peer_send`; private process-bound transport; steering/new-turn delivery; persistent per-sender→recipient allowances and bounded parent-inspectable history. Parent-only connect/disconnect/renew/inspect tools remain under `subagent_*`, so the child guard still rejects every management tool. See [design and acceptance tests](PEER-MESSAGING.md) and the [README](README.md#peer-communication).

### Still deferred

- Channels or shared message boards: distinguish visibility from triggering work in every participant.
- Multi-recipient delivery and authenticated reply/thread relationships, if concrete workflows need them.
- Cross-parent messaging: requires separate identity, ownership and authorization design.
- Durable delivery inboxes, automatic retry/deduplication and model-read/answered acknowledgements. Current receipt means entry into conversation, not model understanding; interrupted/unknown messages are not replayed.
- More selective completion notifications for peer-driven work, if practical use shows existing child-completion reporting is too noisy.

Preserve explicit authorization, bounded work, cancellation/recovery and the separation from management/human approvals when extending the foundation.

## 2. Higher-level workflows and coordination

**Goal:** make repeated patterns such as parallel investigation, implementation followed by review, and dependent handoffs easier to supervise.

**Implemented foundation:** JSON task/check/loop definitions, static DAG scheduling with bounded concurrency, command/agent/human validation, candidate snapshots and digest-bound verdicts, fixed worker/check repair and improvement loops, peer task groups, run-level attempt/deadline limits, observable attempt history and explicit recovery. It reuses the existing child manager and policy; workers do not orchestrate. See [WORKFLOWS.md](WORKFLOWS.md).

### Still deferred until concrete workflows need them

- Dynamic fan-out/graph expansion, conditional routing, quorum/first-success joins and arbitrary nested loop subgraphs.
- In-place workflow revision, reusable executable workflow languages and evaluator plugin frameworks.
- Multiple simultaneously executing workflows in one parent, cross-parent scheduling and a detached supervisor.
- Automatic worktree/source merging, deployment, exact billing/token budgets and OS-enforced evaluator isolation.

Retain KISS/DRY/YAGNI: extend from observed friction in the three supported vertical slices (investigation/synthesis, implementation/repair, and candidate/evaluate/keep-discard), not hypothetical orchestration requirements.

## 3. Optional execution isolation / sandboxing

**Goal:** offer stronger execution boundaries when a task does not warrant unrestricted access to the host.

This was explicitly deferred. The existing guard enforces selected tools and blocks recursive management inside the managed child; it does not contain bash, arbitrary trusted extension code, or direct file access outside the starting directory.

### Questions to resolve

- Which threat model is being addressed: accidental edits, untrusted repositories, adversarial tool output, credential exposure, network access, or intentional escape attempts?
- What boundary is appropriate: OS permissions, containers, another sandbox backend, or remote execution? Which platforms and dependencies can be supported honestly?
- How are readable/writable files, credentials, network destinations, subprocesses and resource limits declared and enforced? Which Pi settings/resources may cross that boundary?
- How do tool/resource allowlists and prompt/context discovery interact with isolation without pretending they are equivalent controls?
- How are artifacts exported for review, and how does process-tree cleanup work after cancellation, parent failure or a backend outage?
- How are unavailable isolation capabilities reported? Requested isolation should fail closed rather than silently run on the host.

### Evidence needed before shipping

Documented boundaries and residual risks, tests for denied filesystem/network/process access, credential handling, cleanup and artifact recovery, plus explicit verification that a missing backend cannot downgrade execution silently.

## Lifecycle architecture: revisit only if required

The current manager belongs to the parent extension. Parent reload/exit stops child processes; saved conversations allow explicit resumption. A separate supervisor could potentially keep work alive across reloads, but it would also introduce ownership, authentication, orphan recovery and shutdown questions.

Treat that as an architectural option to evaluate if communication/workflow requirements demand it—not an already-planned daemon, a promise of uninterrupted execution, or an implicit change to today's lifecycle contract.

## How to advance an idea

For each direction, capture a concrete user scenario, the smallest useful behavior, permission and lifecycle implications, failure cases, and acceptance tests before committing to an API or schema. Update this document as decisions are made, clearly separating implemented behavior from experiments and unresolved ideas.

Deferred ideas establish no new tool names, policy fields or compatibility commitments. Implemented peer API and policy are documented separately in the README.
