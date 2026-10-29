# cursor-plugins bump on 2026-10-29

## Pins

- Source: cursor-plugins, upstream cursor/plugins.
- Checkout: vendor/pstack (shared by cursor-plugins and owner-plugins).
- Old: `ab69380dd50ee47d426b35cb8369cffdddafc218`.
- Candidate: `1ba91fc25c0977741dd0e267849e6234b037ed0a`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/ab69380dd50ee47d426b35cb8369cffdddafc218...1ba91fc25c0977741dd0e267849e6234b037ed0a).
- Maintenance PR: pending creation after validation.

## Upstream scope

Statechart becomes a TypeScript compiler with frontends, passes, backends, a shell launcher, and differential tests. Keep its user-only registry verdict and all runtime resources. Run all upstream compiler suites in a disposable fixture, with installed-only rendering and TLC probes. Test the emitted launcher against the recorded corpus.

Orchestrate replaces the orch runtime with owner and verifier instructions. The orchestrate-host-limits rule keeps nesting conditional on host support and caps concurrency at the live-child limit. Remove obsolete orch rules, the roles overlay, and the deleted test glob. Interrogate now reuses Arena and accepts only findings verified by execution. Arena requires a different-family judge or explicitly skips judgment; its runner fallback retains the requested seat count. Autopilot-stack stacks only dependent PRs. Other changes update video, explanation, setup, and PR guidance.

The mapped compiler pass is named cycle-check.ts to retain the /loop deny token; its import changes with it. The shell launcher uses Node. Slash-skill translation is restricted to Markdown so it cannot corrupt executable paths. No deny tokens were removed or narrowed.

Retired rules: interrogate-launch, interrogate-fields, interrogate-rejected, read-grep-glob-rubric, transcripts-orchestrate, orchestrate-store, control-runtime, orchestrate-local-spawns, orchestrate-spawn-budget, orchestrate-rebase, orchestrate-dashboard, orchestrate-restart, orchestrate-bun, bun-shebang, bun-bootstrap-import, bun-bootstrap-call, bun-import-meta-main, bun-test-orch, erasable-parameter-property. The three two-script Bun guards are replaced by explicit watch-pr-only guards because the orch executable was deleted, not by reducing an existing minimum.

No new, renamed, or removed skill needs a registry verdict. Routes and chains are unchanged; routing eval is skipped for that reason. All source scope decisions and full upstream diffs are recorded in the external cursor receipts. Owner subtrees have no content delta, but share the pin. Packaging outside canonical source maps remains excluded.

## Decisions

## Min-match repair

Rule id
```text
statechart-provisioning-approval
```

Old find
```text
The first run installs TLC and Java with mise, which downloads about 305 MB and needs the network\.
```

New find
```text
The\ first\ run\ installs\ TLC\ and\ Java\ with\ mise\ and\ needs\ the\ network\.
```

Unchanged min
```text
1
```

## Min-match repair

Rule id
```text
statechart-execution-boundaries
```

Old find
```text
Work in a scratch folder outside the repo\. The command writes its files next to its input\.
```

New find
```text
Work\ in\ a\ scratch\ folder\ outside\ the\ repo\.
```

Unchanged min
```text
1
```

## Min-match repair

Rule id
```text
arena-rejected
```

Old find
```text
An `auto` or `inherit-parent` entry in this line or the cross-judge line means the parent model, so omit `model` for it\. If the Task tool rejects a configured entry, run that seat on its family's default and say so\. Families go by prefix: `claude-\*`, and `grok-\*` with `cursor-grok-\*` and `composer-\*`\. A refused `composer-\*` entry runs on `grok-4\.7-xhigh-fast`\. With no family match, use `claude-opus-5-5-xhigh`\. If it rejects a default, use the closest valid slug of the same family from its error message\.
```

New find
```text
An\ `auto`\ or\ `inherit\-parent`\ entry\ in\ this\ line\ means\ the\ parent\ model,\ so\ omit\ `model`\ for\ it\.\ If\ the\ Task\ tool\ rejects\ a\ configured\ entry,\ run\ that\ seat\ on\ its\ family's\ default\ and\ say\ so\.\ Families\ go\ by\ prefix:\ `claude\-\*`,\ and\ `grok\-\*`\ with\ `cursor\-grok\-\*`\ and\ `composer\-\*`\.\ A\ refused\ `composer\-\*`\ entry\ runs\ on\ `grok\-4\.7\-xhigh\-fast`\.\ If\ the\ family\ has\ no\ default,\ or\ the\ Task\ tool\ rejects\ that\ default,\ use\ the\ closest\ valid\ slug\ of\ the\ same\ family\ from\ its\ error\ message,\ or\ drop\ the\ seat\ and\ say\ so\ when\ there\ is\ none\.\ If\ dropped\ seats\ leave\ fewer\ than\ two\ runners,\ add\ runners\ until\ there\ are\ two,\ or\ one\ when\ the\ line\ has\ one\ entry\.\ Run\ each\ added\ runner\ on\ a\ remaining\ runner's\ model,\ or\ omit\ `model`\ so\ it\ runs\ on\ the\ parent\ model\ when\ none\ remain,\ and\ say\ so\.
```

Unchanged min
```text
1
```

## Min-match repair

Rule id
```text
pr-child-nesting
```

Old find
```text
A\ subagent\ that\ opens\ a\ PR\ runs\ `interrogate`,\ `/deslop`,\ and\ `/no\-comments`,\ and\ posts\ the\ URL\.
```

New find
```text
A\ subagent\ that\ opens\ a\ PR\ runs\ `/deslop`\ and\ `/no\-comments`,\ and\ posts\ the\ URL\.
```

Unchanged min
```text
1
```

## Upstream section review

Source is cursor-plugins. The section is skills/poteto-mode/SKILL.md at ## Subagents.
The reviewed hash changes from 1968484284dc to c1bf3bc54126.

```diff
--- old/pstack/skills/poteto-mode/SKILL.md
+++ new/pstack/skills/poteto-mode/SKILL.md
@@ -2,9 +2,9 @@

 **Use `subagent_type: "poteto-agent"` for any subagent you spawn inside a playbook step** (code-writing delegates, ad-hoc helpers). The chat that receives `/poteto-mode` runs the playbook. Never spawn a `poteto-agent` to run the playbook itself. Routed workflow skills (`how`, `why`, `interrogate`, `reflect`, `swarm`) set their own `subagent_type` for diverse-model review. Respect what the skill prescribes, don't override to `poteto-agent`.

-**Defaults for every `Task` call.** `run_in_background: true`, agent mode (readonly strips MCP), file pointers not inlined context, explicit model per role (configurable via `/setup-pstack`. Defaults `grok-4.7-xhigh-fast` for code, `claude-opus-5-5-xhigh` for prose and judgment). Code delegates tier by difficulty. The hardest changes (cross-cutting design, gnarly concurrency, subtle algorithms) go to your strongest judgment model (`claude-opus-5-5-xhigh`), whether the task needs judgment on vague intent or is a precisely specified sequence of steps to execute to the letter. Trivial mechanical edits go to your fast code model. Per-role lines in the `/setup-pstack` rule override these defaults and the model choices in the routed skills (`how`, `why`, `arena`, `swarm`, `architect`, `interrogate`, `reflect`). A role with no line keeps its default, and a role line of `inherit-parent` or `auto` runs that role on the parent chat model (omit Task `model`). Each code playbook's configured model comes from its line (`feature, refactoring`, `bug-fix`, `perf-issue`, or `hillclimb`), and the hardest changes read `hardest tasks`. Prose and judgment read `judgment and prose`.
+**Defaults for every `Task` call.** `run_in_background: true` (a steer or resume of a running agent too, because a foreground call holds your turn while other reports wait), agent mode (readonly strips MCP), file pointers not inlined context, explicit model per role (configurable via `/setup-pstack`. Defaults `grok-4.7-xhigh-fast` for code, `claude-opus-5-5-xhigh` for prose and judgment). Code delegates tier by difficulty. The hardest changes (cross-cutting design, gnarly concurrency, subtle algorithms) go to your strongest judgment model (`claude-opus-5-5-xhigh`), whether the task needs judgment on vague intent or is a precisely specified sequence of steps to execute to the letter. Trivial mechanical edits go to your fast code model. Per-role lines in the `/setup-pstack` rule override these defaults and the model choices in the routed skills (`how`, `why`, `arena`, `swarm`, `architect`, `interrogate`, `reflect`). A role with no line keeps its default, and a role line of `inherit-parent` or `auto` runs that role on the parent chat model (omit Task `model`). Each code playbook's configured model comes from its line (`feature, refactoring`, `bug-fix`, `perf-issue`, or `hillclimb`), and the hardest changes read `hardest tasks`. Prose and judgment read `judgment and prose`.

-**Match the model to the job.** Before each spawn, start from the role's line or default and pick the reasoning level and speed the job needs. The `/setup-pstack` budget sets each role's starting level, xhigh by default. Raise it one step, up to max, for the hardest or subtlest work. Lower it one step for judgment and two or more steps for routine work. Use fast mode only when the job is urgent, meaning CI or trunk is red or a person is blocked on the result right now. Otherwise use standard speed, the same slug without `-fast`. Verification is the exception and stays on the `swarm workers` model and speed (`grok-4.7-xhigh-fast` by default). Change only the effort level and whether the slug is fast, and keep the family the role names, so a diverse panel stays diverse. If the family has no slug at that level and speed, use its nearest slug. A role on `auto` or `inherit-parent` stays on the parent model. If the Task tool rejects the adjusted slug, do not try another adjusted slug. Use the role's line or default and say so.
+**Match the model to the job.** Before each spawn, start from the role's line or default and pick the reasoning level and speed the job needs. The `/setup-pstack` budget sets each role's starting level, xhigh by default. Raise it one step, up to max, for the hardest or subtlest work. Lower it one step for judgment and two or more steps for routine work. Use fast mode only when the job is urgent, meaning CI or trunk is red or a person is blocked on the result right now. Otherwise use standard speed, the same slug without `-fast`. Verification is the exception and stays on the `swarm workers` model and speed (`grok-4.7-xhigh-fast` by default). Change only the effort level and whether the slug is fast, and keep the family the role names, so a diverse panel stays diverse. If the family has no slug at that level and speed, use its nearest slug. A role on `auto` or `inherit-parent` stays on the parent model. If the Task tool rejects the adjusted slug, do not try another adjusted slug. Use the role's line or default and say so. If the Task tool rejects that too, continue with the calling skill's fallback. A slug counts as rejected once a Task error says that the model is not valid, or leaves the slug out of its list of valid slugs. Never pass a rejected slug, and skip any fallback whose slug is already rejected. When the calling skill has no fallback, use the closest valid slug of the role's family from the error's list of valid slugs, or omit `model` so the subagent runs on the parent model when the list has none. When the calling skill's fallback runs out of slugs without saying what to do next, omit `model` too. Say so in both cases.

 You own every subagent's work. Review the diff and write your own summary, don't pass through what it said. A second opinion is the same prompt against a different model. Agreement is high-signal.

```

The overlay decision is: Carry background steers and resumes, avoid retrying rejected models, and retain host catalog fallback.

## Upstream section review

Source is cursor-plugins. The section is skills/setup-pstack/SKILL.md at ### 3. Budget, map, and confirm.
The reviewed hash changes from a771eeed4d13 to 5474d2863c46.

```diff
--- old/pstack/skills/setup-pstack/SKILL.md
+++ new/pstack/skills/setup-pstack/SKILL.md
@@ -9,5 +9,5 @@

 **(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`, `auto`). `unlimited`, `large`, `medium`, and `small` set the effort token of every real slug, panel entries included, to `max`, `xhigh`, `high`, or `medium`. The effort token is the last token, or the one before a trailing `fast`, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. If the result is not a detected slug, use the same family's detected slug with the highest effort at or below the target, else mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `unlimited` turns `claude-opus-5-5-xhigh` into `claude-opus-5-5-max`. Grok slugs top out at `xhigh`, so under `unlimited` the fallback puts Grok at `xhigh` and keeps `grok-4.7-xhigh-fast` as it is. `large` keeps both defaults. `small` turns them into `claude-opus-5-5-medium` and `grok-4.7-medium-fast`.

-**(c) Show the roles and confirm.** Show every role with its model, marking any real slug not in the detected set as needing a choice. Also list each line step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model, which is how Auto users stay on Auto) as the options. Prefer AskQuestion over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.
+**(c) Show the roles and confirm.** Show every role with its model, marking any real slug not in the detected set as needing a choice. Also list each line step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model, which is how Auto users stay on Auto) as the options. Prefer AskQuestion over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena runs one judge. It tries only values from a family other than the parent's, in list order, so order it by preference. An `inherit-parent` or `auto` value never judges. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

```

The overlay decision is: Require a different-family judge in pool order and exclude parent-model aliases.

## Upstream section review

Source is cursor-plugins. The section is skills/poteto-mode/SKILL.md at ## Playbooks.
The reviewed hash changes from 1cb462bc465e to 0c117292cd90.

```diff
--- old/pstack/skills/poteto-mode/SKILL.md
+++ new/pstack/skills/poteto-mode/SKILL.md
@@ -21,7 +21,7 @@
 - **Autonomous run.** A long task to drive to completion without stopping ("run until done", "/loop until X").
 - **Orchestrate.** A standing project handed to one coordinator chat: multi-day, many stacked PRs, dozens to hundreds of subagents, minimal human turns ("run this whole project", "own this migration until it lands"). Distinct from Autonomous run, which drives one task to a predicate. Work one agent could finish inside the session's budget routes there, not here, however program-shaped the phrasing sounds.
 - **Autopilot-full.** A queue of independent PRs run to merged with full autonomy. One owner per PR carries build through merge, and the root swarm-verifies each PR before its owner merges ("autopilot this queue", "full autopilot", one-owner-per-PR programs).
-- **Autopilot-stack.** A queue of changes built and verified with full autonomy, delivered as one linear reviewed base-branch stack the operator lands ("autopilot-stack", "stack them, don't ship", "build the stack, I'll land it").
+- **Autopilot-stack.** Autopilot-full without the merge. A queue of PRs built and verified with full autonomy, then handed to the operator to land. A PR stacks only on a PR it builds on ("autopilot-stack", "autopilot, don't merge", "stack them, don't ship", "build the stack, I'll land it").
 - **Session pickup.** Resuming or taking over a prior agent's in-flight work from a transcript, cloud-agent URL, or pushed branch.
 - **Pause safely.** Suspending in-flight work cleanly so it can be resumed, on an explicit pause, going offline, a Cursor restart, or imminent context compaction. The complement to Session pickup.
 - **Multi-phase or multi-PR plan.** Work that spans phases or stacked PRs. File: `playbooks/multi-phase-plan.md`.
```

The overlay decision is: Retain the registry-owned router overlay. Upstream dependency-only stacking remains in the emitted Autopilot-stack playbook.

## Generated changes

Generated output follows the reviewed decisions above. The second generation must match the staged generated output byte for byte; see `/home/danballance/.local/state/p3stack-maint/2026-10-29-b42a41d6/cursor/determinism-final.json`.

## Verification

Complete command streams and exit codes: `/home/danballance/.local/state/p3stack-maint/2026-10-29-b42a41d6/cursor/`.

- Baseline: original current-pins audit and dependency baseline npm/pnpm root gates passed.
- Candidate: package checks/tests, static host checks, registry, final root gate, and local Pi loader/smoke passed. Results are in `root-resume.json`, `static-resume.json`, and `smoke-resume.json`.
- Authored registry: four rows; zero unclassified.
- Live T3 audit: original genuine doctor and bridge smoke are in `audit/`; current Codex catalog is in `live-codex-catalog.json`. This resumed Codex process has no Pi bridge environment; final fresh-process smoke uses native Pi with explicit openai-codex/gpt-6-astra and medium thinking. No installed host or fingerprint changed.
- Optional TLC and renderer tests skip when installed tools are absent. Recorded-corpus compiler and CLI tests still run.
- Routing eval: skipped; no route or chain changes.

## Follow-up

Depends on [dependency prerequisite #85](https://github.com/daniel-ballance/pi-packages/pull/85), verified commit `711e176cc9f176e0a0d1e49dda6a720ea1c99b50`. Source PR contains no dependency-lock changes. All PRs remain unmerged.
