# Workflows

A small parent-owned DAG scheduler built on the existing subagent manager. The parent authors JSON, starts a run and supervises exceptions; workers do tasks. No daemon, executable DSL, database, dynamic graph expansion or recursive worker orchestration.

## Getting started

1. Use `/skill:workflows` and `subagent_catalog` to choose real allowed worker compositions.
2. Write a JSON definition using the examples below. Starting a workflow authorizes its listed tasks and commands within its limits; inspect the definition first.
3. `subagent_workflow_start({"path":"/absolute/path/to/workflow.json"})` returns acceptance and a run ID. Execution continues while the parent is idle.
4. `subagent_workflow_inspect({"id":"workflow-…"})` shows progress, attempts, child IDs, artifacts and latest validation. Add `step` for full attempt history. Omit `id` to list runs.
5. `subagent_workflow_control({"id":"workflow-…","action":"pause"|"resume"|"cancel"})` controls execution. Cancelling the start tool does not cancel an accepted run.

`/workflows` lists runs. `/workflows inspect <id> [step]`, `pause <id>`, `resume <id> [retry-step …]` and `cancel <id>` provide human controls. `/workflows approve <id> <step>` or `reject <id> <step>` records a human check decision; resume explicitly afterward. There is deliberately **no model-callable human-approval operation**.

One workflow executes per parent at a time; paused/blocked runs can be retained while another executes. Its children share the parent's live-child cap with manually spawned children. A task can therefore wait for available child slots; inspect child IDs/status through ordinary subagent tools. Workflow children are closed when their task/group finishes. They are not persistent workflow orchestrators.

## Definition

```json
{
  "version": 1,
  "name": "Parallel investigation",
  "cwd": "/absolute/path/to/project",
  "limits": { "concurrency": 2, "maxAttempts": 8, "timeoutSeconds": 300 },
  "steps": [
    {
      "id": "investigate",
      "kind": "task",
      "worker": { "model": "example-provider/example-model:off", "tools": ["read"] },
      "instructions": "Investigate the requirements. Return evidence and unknowns."
    },
    {
      "id": "review",
      "kind": "check",
      "input": "investigate",
      "validator": { "kind": "human", "instructions": "Is the investigation sufficient?" }
    }
  ]
}
```

Model IDs and paths in examples are placeholders. `worker` uses the same model/tools/resources/prompt/context-file composition as `subagent_spawn`; there are no profiles or inherited worker tools. Unknown definition fields fail validation. Model/resource availability is rechecked on start, resume and execution.

- `limits.concurrency`: 1–64, no higher than policy `maxChildren`. Counts running steps, including checks; a connected peer task group occupies one slot per worker.
- `limits.maxAttempts`: 1–1000 across the whole run. **Every worker and every check** consumes one attempt, including baseline evaluation and human checkpoints. A repair iteration normally costs two attempts. New children, retries and resume do not reset the count.
- `limits.timeoutSeconds`: 1–86400, a wall-clock deadline starting at creation. Pausing does not extend it. Cleanup uses the existing bounded child shutdown and command termination grace, so termination is not instantaneous.
- `steps`: 1–64, unique alphanumeric/dash/underscore IDs starting with a letter.
- `dependsOn`: optional list of steps whose outputs must be available. Dependencies form a DAG; `seed` and check `input` automatically add dependencies. Independent ready steps run concurrently, fan-in waits for all prerequisites.

### Task

`{id, kind:"task", worker, instructions, dependsOn?, seed?}`

The runtime supplies input artifact paths and bounded summaries, a fresh candidate directory, and any connected peer IDs. Workers should write only candidate files there, not edit the source project or evaluator. A final reply is required and is saved as `response.md`; that filename is runtime-reserved. Text-only workers need no write tool.

`seed` names a predecessor whose artifact tree is copied into the candidate directory. Other dependency artifacts are provided as inputs, not implicitly merged. Workers must explicitly synthesize/merge multiple inputs when needed.

A completed task means **an artifact was submitted**, not that its content is correct. Put a check between submission and downstream work wherever validation is required.

### Check

`{id, kind:"check", input, validator, dependsOn?}`

Checks evaluate the exact submitted artifact from `input`. Passing checks forward that artifact; failure blocks downstream work. Validators:

- **Command:** `{"kind":"command","command":"…"}`. Runs through `bash -c` in the workflow cwd. Requires `bash` in the effective subagent tool policy and an allowed cwd. Environment includes `WORKFLOW_CANDIDATE` (artifact directory), `WORKFLOW_RUN` and `WORKFLOW_ATTEMPT`. Exit 0 means pass, exit 1 means validation failure, other exits mean evaluator execution error. Optionally return JSON on the last nonempty stdout line: `{"verdict":"pass|fail|blocked","findings":"…","score":12.3}`. Exit 1 cannot report pass. Full combined output is capped at 1 MiB in `command.log`; parsing uses the last 16000 stdout characters.
- **Agent:** `{"kind":"agent","worker":{…},"instructions":"rubric…"}`. A separate child receives the candidate path/summary and must return the JSON verdict above. Its tool/resource permissions remain explicit. The verdict is model judgment, not proof.
- **Human:** `{"kind":"human","instructions":"question…"}`. Blocks until the human slash command records pass/fail. No child or scheduler grants human approval. The decision is bound to the submitted artifact digest.

`score` must be a finite number when supplied. Invalid JSON and broken evaluators block execution rather than masquerading as a failed candidate. Multiple independent checks can be ordinary DAG steps, followed by an all-dependencies join. No validator plugin framework is needed.

### Loop

`{id, kind:"loop", worker, instructions, validator, mode, maxIterations, dependsOn?, seed?, direction?, minImprovement?, target?}`

This first version deliberately has a fixed **worker → check** body, not an arbitrary nested workflow language. Human approval belongs after a loop, not inside it. `maxIterations` is 1–100.

- **repair:** The next iteration copies the previous failed candidate and receives validation feedback. Stop on pass. Iteration/total-attempt/deadline exhaustion is **not success**; downstream work stays pending.
- **improve:** Requires `seed` and `direction: "min"|"max"`. First validate the seed to establish a passing numeric baseline. Every candidate starts from the best accepted artifact. Adopt only passing candidates with score improvement strictly greater than `minImprovement` (default 0); otherwise discard them as the next baseline, while retaining their artifacts/results. All decisions are recorded as keep/discard. Optionally stop at `target` (score ≤ target for min, ≥ target for max). Without a target, completing the planned iterations returns the best valid baseline; with an unmet target, exhaustion is reported honestly. Global attempt/deadline exhaustion always exhausts the run, even if a useful best candidate exists.

Iteration counters, feedback, candidate artifacts and accepted baseline survive explicit continuation. Interrupted iterations consume their already-reserved iteration/attempt allowance; they are not invisibly repeated.

## Optional peer task groups

```json
"peers": [{ "a": "proposer", "b": "critic", "limit": 3 }]
```

Endpoints must be task steps with the same dependency set, both explicitly selecting `peer_send`. Their connected group must fit within run concurrency and policy live-child limits. The runtime starts all group children idle, establishes the existing bidirectional/non-transitive links, supplies peer IDs, then prompts them. It waits for the whole group to settle before collecting outputs, disconnecting and closing the children. Traffic uses the existing per-direction manager-enforced allowance. Peers cannot advance the DAG or accept another task's output merely by chatting.

Worker instructions define the conversation protocol and when to stop. Retrying an interrupted group explicitly retries all its members; new attempts count against the same run allowance. Automatically linked groups inside loop bodies are deferred.

## Artifacts, validation and boundaries

State is a plain `run.json` under `<parent manager directory>/workflows/<run-id>/`. Each numbered attempt has its candidate/review directory, copied artifact snapshot, command log when applicable, child IDs, verdict, and keep/discard/revise decision where relevant. Child sessions/logs stay in the existing manager.

After workers close, the runtime copies their candidate files into a distinct artifact directory and records a SHA-256 tree digest. Trees reject symlinks/special files. Checks and downstream handoffs verify the digest; checks must not modify the submitted artifact. Failed candidates remain inspectable; improvement loops do not overwrite their accepted baseline. Outputs are never automatically applied to the source project, merged, pushed or deployed.

**This is not a sandbox or a filesystem ACL.** Workers and commands with host-level tools can access outside their assigned paths, and arbitrary trusted code/background processes are not contained. Digest checks detect changes at the boundaries where they run; they do not prevent adversarial writes or guarantee that a worker cannot alter an external evaluator. Use external OS isolation for that threat model. Commands may execute candidate code, so authorize them accordingly. No exact billing, disk quota or token-budget enforcement is implied by the three run limits.

## Monitoring, failure and recovery

Inspect shows run status/reason, used attempts, remaining time, per-step status/iteration, child IDs, accepted/best artifacts and latest check/error. Detail inspection includes every attempt; oversized results use the existing tool-result spill-to-file behavior. All findings are untrusted worker output, not permissions.

Only completion, blockage, pause/cancellation or exhaustion generate workflow notices, using the existing durable idle-batched notification machinery. Routine owned-child completion chatter is suppressed. Reading a run acknowledges its status notice; listing runs does not. Ordinary child tools still inspect logs, but manually sending/closing workflow workers can interrupt the workflow and is not a normal orchestration path.

- **Pause:** stop scheduling new steps/iterations; current steps/iterations may finish, still within the original deadline.
- **Cancel:** abort active children/commands, stop scheduling, preserve artifacts/history. No rollback of edits or external effects outside candidates.
- **Failure/blockage:** stop scheduling and interrupt active sibling work. Completed independent artifacts remain available.
- **Reload/exit:** stop active work and retain a paused run. No automatic restart/replay. A parent crash can still orphan processes as described in the main README.
- **Resume:** revalidate current policy; retain the original deadline and counts. Explicitly list `retry` step IDs for failed/interrupted work after inspecting possible side effects. Peer siblings retry together. Completed downstream work cannot be silently invalidated. Exhausted/cancelled runs require a new, explicitly authorized run for further work. Definitions are not edited in place during execution; revise the JSON and start a new run instead.

Worker extension dialogs currently block the attempt and are closed during cleanup; they are not silently answered. Arrange the needed input before retrying, or use an explicit human check in the graph.

## Examples and tests

- [Parallel investigation → synthesis](skills/workflows/examples/investigate.json)
- [Implementation → deterministic check → repair](skills/workflows/examples/repair.json)
- [Baseline → candidate → evaluate → keep/discard](skills/workflows/examples/improve.json)

`npm run check` and `npm test` include scheduler, artifact, limits, recovery and real parent/child workflow tests. To exercise the installed Pi executable as well as the package's Node CLI:

```bash
PEER_TEST_EXECUTABLE="$(command -v pi)" node --import tsx --test test/workflows-rpc.test.ts test/workflows-parent-rpc.test.ts
```

For deterministic TUI testing, load `test/fixtures/workflow-parent-provider.mjs` with this extension in an isolated agent directory, set `WORKFLOW_SMOKE_DEFINITION` and `WORKFLOW_SMOKE_OUTPUT`, and prompt `WORKFLOW SMOKE`. The fixture launches the workflow, leaves the parent idle, then inspects it after its completion notice. No provider network calls are made.

### Verification — 2026-09-23

- TypeScript check and all **106 tests** passed. Real parent/child workflow suites passed with both the package's Node Pi CLI and installed Pi 0.87.1 (Bun).
- Real RPC fixtures exercised fan-out/fan-in, repair, numeric baseline/keep/discard improvement, independent reviewer checks, peer task groups and cleanup. The parent remained idle during execution and received one workflow completion notice.
- Isolated tmux smoke passed at 140 and 70 columns, before/after `/reload`, with compact `/workflows` listing and expanded tool results.
- After self-reload, a live GPT-6 Luna workflow (`workflow-415668d9`) completed two parallel text tasks, an intentionally failing candidate followed by automatic repair, and an independent read-only artifact reviewer: **7 attempts, 2 repair iterations, 5 workers, all closed without errors**. Child policy/tool logs confirmed writes only to disposable `answer.json` candidates; no repository implementation was delegated. This tests runtime behavior, not general model quality.
- Package dry-run includes workflow source, contract, skill and all three example definitions.
