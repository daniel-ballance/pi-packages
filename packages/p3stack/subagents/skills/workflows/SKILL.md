---
name: workflows
description: >
  Author and supervise bounded workflows in a terminal Pi parent: task DAGs, fan-out/fan-in, deterministic or agent/human validation, repair and improvement loops, peer task groups, observability and explicit recovery. Use for autonomous multi-step work or repeated candidate/evaluate/keep-discard experiments.
---

# Author and supervise workflows

Use this in a terminal Pi parent with `subagent_catalog.features.workflows` true. Under T3 Code use its `delegate_task` and `task_status` instead; they do not run this JSON scheduler.

Read [the workflow contract](reference/contract.md) before creating a definition. Use the examples ([investigate](examples/investigate.json), [repair](examples/repair.json), [improve](examples/improve.json)) as shapes, not runnable configurations: model IDs and paths are placeholders.

1. Establish the outcome, inputs, actual acceptance criteria and permitted actions with the user. Prefer deterministic evaluation where meaningful; use an independent agent rubric or human checkpoint where necessary. Do not invent a numerical metric just to have one.
2. Consult `subagent_catalog`. Activate deferred management tools with `subagent_catalog({activate:[name]})` or find them with `tool_search`. Choose explicit worker compositions from it. Workers get policy `alwaysTools` and `alwaysExtensions`, not this parent's conversation or chosen tools. Provide enough context, source paths and expected outputs in instructions.
3. Write a JSON definition: `version:1`, `name`, absolute allowed `cwd`, explicit `limits` (`concurrency`, `maxAttempts`, `timeoutSeconds`), and task/check/loop `steps`. Dependencies form a DAG. Every worker/check costs one attempt; a loop iteration normally costs two. Budgets are not exact provider billing limits.
4. Keep candidate changes inside runtime-supplied candidate directories. Preserve source/evaluators; artifact snapshots are not an OS sandbox. Design validators against `WORKFLOW_CANDIDATE`. Commands require policy `bash`, run on the host and may execute candidate code. Explain consequential permissions before launching.
5. For peer discussion, check `features.peers`; task endpoints must have identical dependencies, select `peer_send`, and fit together within concurrency. Add explicit `peers` links/limits and instructions for who speaks first, reply conditions and stopping. The runtime supplies IDs and closes the group after settlement. Chat is not acceptance.
6. Start with `subagent_workflow_start({path})`. Acceptance is not completion. Inspect with `subagent_workflow_inspect({id,step?})`; use child IDs and log/artifact paths for evidence. Routine progress is available without polling continuously; completion and exceptions notify the parent.
7. Checkpoints: pause is cooperative at step/iteration boundaries; cancel interrupts active work. A human Halt/Kill holds the worker and its workflow: discuss the intervention with the user before releasing each child hold and then the workflow barrier with `subagent_release_hold`. Release starts nothing; do not bypass a hold with replacement work. On interruption, inspect effects before `subagent_workflow_control({id,action:"resume",retry:[stepIds]})`. No automatic replay, permission expansion, deadline reset or replenishment. Human checks require the user's `/workflows approve|reject <id> <step>` command, not a model decision.
8. Verify final evidence and distinguish submitted task output from validated output, accepted baselines from failed candidates, and useful partial results from fulfilled targets. Source merges/publication remain separate authorized actions.

Keep workflows small. Start with explicit fan-out/all-input fan-in and fixed worker/check loops. No dynamic graph expansion, arbitrary executable definitions, workflow-editing tools, nested loop graphs or evaluator plugin framework exist in this version.
