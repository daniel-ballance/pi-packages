# Subagents: future directions

This records ideas deliberately deferred while building the persistent-child foundation. **It is not a release schedule or a specification of supported features.** Peer communication, higher-level workflows and sandboxing are not implemented. The design questions below are starting points, not settled API or configuration decisions.

See the [README](README.md) for the current behavior and policy contract.

## Principles to retain

- The parent composes children from allowlisted ingredients, rather than choosing mandatory predefined agent profiles.
- Policy remains explicit and fail-closed. New capabilities must not silently broaden existing configurations.
- Children cannot recursively manage other children through the extension's management tools. Communication must not grant spawn, resume, abort, close, policy-editing or approval authority.
- Agent messages are delegated work output, not user instructions or permission grants. Human-required approvals remain human decisions.
- Persistent conversations, observable lifecycle state, bounded output and reliable cleanup remain core requirements.
- Notifications should represent unread, actionable work rather than duplicate reports or routine chatter.
- Tool allowlists and working-directory restrictions must not be described as an OS-level sandbox. Unrestricted bash can bypass process-level conventions.

## 1. Inter-subagent communication

**Goal:** let cooperating children exchange questions, findings and handoffs without making the parent manually relay every message.

Today, the parent can read one child's findings and send relevant information to another. There is no dedicated peer messaging capability. A future communication interface must be distinct from management access; the current guard rejects all `subagent_*` tools in children, so both capability separation and tool naming need explicit design.

### Questions to resolve

- Should the manager broker messages, expose per-child inboxes, or use another transport? What must the parent be able to inspect or intervene in?
- Does the parent explicitly permit individual sender/recipient pairs, groups, or communication within a particular task? What is the default-deny boundary?
- Should the first version be restricted to children of the same parent? Cross-parent messaging would require a separate identity, ownership and authorization design; it is not implied by peer support.
- How are sender identity, recipient identity, task/run identity and reply relationships authenticated and recorded, rather than accepted from model-written text?
- When is a message considered accepted, delivered, read or answered? How do ordering, duplicate suppression and read acknowledgements survive reload?
- What happens when a recipient is busy, awaiting human input, stopped, closed or resumed? Queuing a message must not silently restart an abandoned child or grant permission to resume it.
- Should a message wake an idle child, wait for its next turn, or require parent approval? How do we prevent ping-pong conversations, unbounded inboxes and surprise provider usage?
- Which peer exchanges merit a parent notification, and which should remain inspectable history? Existing read acknowledgement, idle batching and explicit-close dismissal should continue to make sense.

### Evidence needed before shipping

Tests for unauthorized recipients and spoofed identities; durable delivery/read semantics; stopped-recipient and reload behavior; cancellation during an exchange; bounded messages and wakeups; and proof that messaging does not expose management or human-approval capabilities.

## 2. Higher-level workflows and coordination

**Goal:** make repeated patterns such as parallel investigation, implementation followed by review, and dependent handoffs easier to supervise.

Today, the parent builds these patterns using spawn/send/wait/read/close. A workflow layer should build on those primitives, not replace explicit model/tool/resource composition with hidden defaults or mandatory profiles.

### Questions to resolve

- What needs a first-class representation: task dependencies, acceptance criteria, handoffs, reviewer assignments, or simply reusable parent-side guidance? Start with concrete repeated friction before introducing a workflow language.
- How does a dependency become satisfied: a child saying “done,” a verified artifact, passing tests, or explicit parent acceptance? A completed model turn alone is not proof of task success.
- How are failures, retries, timeouts, partial completion and user cancellation propagated? Retrying must not replay non-idempotent file edits or external actions without considering their effects.
- What is the workspace coordination model? Possible approaches include explicit file ownership, separate worktrees, or parent-reviewed patch handoffs. Shared-directory edits need a conflict policy; a worktree alone is not a sandbox.
- How are live-process limits, provider concurrency, usage estimates and any future budgets handled across a workflow? Current cost reporting is not budget enforcement, and subscription estimates are not exact bills.
- How do workflow state and message history remain consistent through parent reload and explicit child resumption? Recovery must distinguish retained progress from permission to run again.
- Which decisions remain with the parent or user, especially acceptance, merging changes, changing permissions and approving consequential actions?

### Evidence needed before shipping

A small number of useful end-to-end workflows with inspectable state, predictable cancellation/recovery, conflict handling and bounded resource use. Prefer a minimal coordination layer over a large orchestration framework until experience establishes a need.

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

No new tool names, policy fields or compatibility commitments are established by this roadmap.
