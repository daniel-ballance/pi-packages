# Workflow templates

Use these only in a terminal whose parent exposes workflows and whose policy permits every requested model, tool and skill. Under T3 Code, or if policy won't authorize the definition, follow the prose procedure. Do not widen permissions to run a template.

The engine orders dependent steps, snapshots submissions, checks artifact digests at handoffs and limits concurrency, attempts and time. A submitted artifact is not a verified result. Worker instructions are not filesystem isolation, blinding, or proof that the worker followed them.

| Template | Engine steps | Parent gate |
|---|---|---|
| `interrogate.json` | Three readers, then a collector with all three artifacts. No command check. | Match each finding to its proposed reproduction; verify below. |
| `arena.json` | Two proposals feed a pick, then synthesis. An agent checks the synthesis artifact. | Score the proposals yourself against the rubric. Inspect the pick and grafts and resolve differences. Check the design and handoff summary did not disclose the decision to the reviewer. An agent verdict is a judgment. |
| `hillclimb.json` | A hash check gates the seed. The loop evaluates it and keeps passing artifacts only on a score improvement strictly greater than `minImprovement`. | Calibrate the workload and regression gate. At handback compare the best score and attempts with the user's target; iteration completion is not target attainment. |
| `skill-eval.json` | Two submissions feed one grading task. | Hold model **and thinking level constant**: vary the skill, not the model. Use the same base commit and organic request, neutral run/skill names, and keep the label-to-variant mapping private. Check both patches against the base. For a behavioral criterion, give the grader the corresponding transcript or record null. |

**Interrogate handback.** The parent reads each proposed reproduction as data. In a disposable checkout of the exact reviewed tree (including in-scope uncommitted files), run the inspected steps yourself under the grant, with a timeout. Compare observed output to the stated intent, not the script's exit convention. Record **verified** (observed violation), **contradicted** (observed correct behavior) or **could not run** (unsafe, blocked or inconclusive), with command, output/status and evidence path. Never execute a submitted script in the operator's checkout.

**Hillclimb inputs.** Before launch, assemble only the allowed starting files in a seed directory. Freeze its hash with `node "<p3stack-mode directory>/scripts/seed-hash.mjs" "<seed directory>"`. Set `seedDir` to that directory, `seedHash` to the printed SHA-256, and `hashTool` to the shell-quoted absolute script path. The check compares the submitted names, executable bits and bytes against that hash, excluding only the runtime's top-level response.md.

**Hillclimb evaluator.** Supply a trusted, frozen command. Test the files in `"$WORKFLOW_CANDIDATE"`, not the workflow cwd; if builds write files, build in a disposable copy. Run the same regression gate and workload on seed and trials. End stdout with one JSON line, e.g. `{"verdict":"pass","findings":"gate passed; median ms","score":12.3}`: pass requires a finite numeric score and exit 0. On regression emit fail with findings and exit 1; report an evaluator error separately (exit 2). Do not modify the submitted artifact.

**Skill-eval handback.** Set `base` to a full commit ID reachable in the local source repo. Each worker makes its own checkout inside its assigned output directory and exports a binary patch including committed, staged, unstaged and new deliverables. The runtime still shows assignment metadata and output paths. If strict blinding matters, use separate neutral sessions instead.

## Start

1. List inputs with `node "<p3stack-mode directory>/scripts/workflow-template.mjs" <template.json> --list`.
2. Resolve the roles against the live catalog. For adversaries and judges request a family distinct from the author where available; the engine does not enforce family diversity.
3. Fill the definition: `node "<p3stack-mode directory>/scripts/workflow-template.mjs" <template.json> --set name=value ... --out <store>/runs/<run-id>/workflow.json`. Inspect the resulting commands: JSON substitution is not shell quoting.
4. Start and supervise per **Run a workflow** in the [host map](../poteto-mode/references/host-capabilities.md). To resize a panel, update its dependencies, prompts and limits together before starting.
