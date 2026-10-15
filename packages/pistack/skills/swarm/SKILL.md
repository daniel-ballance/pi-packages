---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Fan out N parallel workers. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers. When N exceeds the live-child limit, run the workers in waves (**Delegate** in the [host capabilities](../poteto-mode/references/host-capabilities.md)).
4. Pick the worker model from the `swarm workers` role in the role defaults. If no role default is set, use `grok-4.7-xhigh-fast`. For `auto` or `inherit-parent`, the workers run on your own model (**Parent model** under **Delegate**). Resolve the model per **Models and role defaults** in the [host capabilities](../poteto-mode/references/host-capabilities.md). If the catalog does not offer it, use the default and say so. If it does not offer the default either, use the closest offered model of the same family. For a model race, name each arm's model up front. Pick each subagent's reasoning level for the job, per the Subagents section of the **poteto-mode** skill.
5. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Delegate all N workers at once per **Delegate** in the [host capabilities](../poteto-mode/references/host-capabilities.md), on the step 4 model (your own model for `auto` or `inherit-parent`). Give each worker that writes its own checkout per **Isolation**.

When a worker must start from a non-default branch, create its checkout from that branch.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
