# Workflow templates

Templates for the subagents workflow engine. Each one backs a p3stack procedure whose mechanics a runtime can enforce better than prose. They are a terminal accelerator: under T3 the subagents package is inactive, so follow the skill's prose procedure and say so.

| Template | Backs | What the runtime enforces |
|---|---|---|
| `interrogate.json` | `interrogate` | Three adversaries on separate models, a collector, then a command check that reruns every `repro.sh`. Only findings whose repro observes the failure are reported as proven. |
| `arena.json` | `arena`, `architect` Phase B | Two runners, a synthesis that picks a base and grafts at most two ideas, then an agent check against the contract on another model family. |
| `hillclimb.json` | Hillclimb playbook | A baseline copy, then an improvement loop: one hypothesis per iteration, kept only when the evaluator's score improves. |
| `skill-eval.json` | Eval playbook | Two blinded candidates on the same organic prompt, one with each skill variant, each submitting its `git diff`, then one grader scoring both in one pass. The grader scores what the diffs show; behavior only a transcript shows (a test run red before the fix) stays `null` for the parent to grade from the candidates' transcripts. |

## Use

1. List a template's placeholders: `node <p3stack-mode directory>/scripts/workflow-template.mjs <template> --list`.
2. Resolve every model with `p3stack_roles` (`distinctFrom` the author's model for adversaries, judges, reviewers, and graders) and check them against `subagent_catalog`.
3. Fill it: `node <p3stack-mode directory>/scripts/workflow-template.mjs <template> --set name=value ... --out <store>/runs/<run-id>/workflow.json`. Placeholders inside text are `{{name}}`; whole numbers are `"{{name:number}}"`. A placeholder left unfilled, or a value for one that does not exist, is an error.
4. Start it with `subagent_workflow_start`, which validates the definition against the live policy, then supervise it per **Run a workflow** in the poteto-mode host capabilities.

To change the number of adversaries, runners, or candidates, copy or delete steps in the filled file before starting it.
