# Maintain p3stack

Change the input, not the generated file. For runtime behavior, see [About p3stack](../../docs/p3stack.md). For a current-pin audit, an authorized bump, or a revert, follow [maintain-p3stack](authored/skills/maintain-p3stack/SKILL.md).

## Inputs and outputs

- [`rules/manifest.json`](rules/manifest.json) maps upstream paths to output paths, excludes resources, and identifies the checkout for each named source. Use the canonical upstream trees, not Cursor's generated `harness/pstack/` copies. [`rules/borrowed.json`](rules/borrowed.json) lists upstream paths whose changes need review even though p3stack restates them locally.
- [`registry/skills.json`](registry/skills.json) classifies each skill in the source's `skillRoots` and in `authored/skills/`. A drop excludes the whole skill directory. An emit names the skill and specifies `model` or `user` invocation. A `reference` names an emitted `owner`; keep rules and patches scoped to the old skill path. After patching, the generator moves the entry to `skills/<owner>/references/<name>.md` and its resources to `references/<name>/`; use the qualified reference path in routes and chains. Register an authored skill with `source: "p3stack"` and a path relative to `authored/`.
- [`registry/routes.json`](registry/routes.json) supplies the router and the jobs in `poteto-help`. Help then lists skills with no direct route, using the first description sentence unless [`rules/help-jobs.json`](rules/help-jobs.json) gives a clearer job to ask for. Each request and grant pair must be unique. Use `any`, `default`, or `full-autonomy` and either a target or an inline action.
- [`registry/chains.json`](registry/chains.json) adds conditional reads **in the playbook**, marked **p3stack only**. Give each row a unique ID and anchor it before or after a unique top-level step. There is no router chain table or generated `p3stack-mode/references/routes.md` or `chains.md`.

The generator replaces only `skills/`, `agents/`, `LICENSE`, `LICENSE-agent-skills`, `LICENSE-matt-pocock`, and `LICENSE-superpowers`. Staging a file outside those roots fails, even from a patch. The generator also updates the pin text between the README markers and `package.json#p3stack.upstream` (the Cursor pin).

## Translate or add a file

1. For a change to an upstream sentence, add a scoped rule in [`rules/tokens.json`](rules/tokens.json). Rules run in order. `min` counts matches across the selected `source` and `files` after earlier rewrites. A failing minimum names the rule and scope. Check whether upstream reworded or removed the text before changing the rule. `{{skills.names}}` in `find` matches emitted upstream skill names. Translate slash commands, not paths or URLs.
2. To replace a section, name its heading and overlay in [`rules/sections.json`](rules/sections.json). Both the raw `upstreamHeading` (defaults to `heading`) and the rewritten `heading` must occur exactly once and be leaves. Setext headings count. A token rewrite cannot move the section boundary. `upstream` must match the first 12 hex digits of the raw section's SHA-256. Review upstream changes before updating the hash. If upstream adds children, target the leaves rather than replacing the parent. Token replacements and overlays can use `{{upstream.commit}}` for the file's source pin.
3. Use `extra/` for the host map and test shims, and `authored/` for p3stack's skills and playbooks. Both copy without token or section rewrites, `extra/` first. The registry renderer runs next. Two upstream sources cannot emit the same path. To replace an existing file at a later copy or render step, declare `{"file": "…", "from": "…", "by": "…"}` in the manifest's `overwrites` array. The path and both producer names must match.
4. Use `patches/*.patch` for a change that needs a diff, such as porting a playbook helper to Node. Patches apply in name order to the staged tree with fixed whitespace settings. Rebase a stale patch against that tree.

The registry checker reads `name`, `description`, and `disable-model-invocation` only from the leading YAML frontmatter. It requires the registered name, a nonempty description, and the registered invocation. Generation sets the invocation flag for upstream skills. Set it in the source for authored skills.

Write skill links relative to the skill directory. Describe operations by capability. In `extra/skills/poteto-mode/references/`, [host-capabilities.md](extra/skills/poteto-mode/references/host-capabilities.md) holds the shared instructions and links each heading to [host-terminal.md](extra/skills/poteto-mode/references/host-terminal.md) and [host-t3.md](extra/skills/poteto-mode/references/host-t3.md). Keep host tool names in their own host's file. `lint-hosts.mjs` checks both host files and rejects recognized host tool names everywhere else in the emitted tree. The shared entry may carry only the `mcp__t3-code__*` namespace marker. `lint-authored.mjs` checks authored text for model names. Neither lint tests runtime behavior.

## Generate and check

Install the workspace first. From this package:

```sh
npm run generate            # build and validate in staging, then replace the owned roots
npm run generate -- --check # compare fresh output and pins without installing
npm run check               # drift, lints, static T3 contract, description lint, types
npm test                    # offline suites, including compiler, playbook helpers and packlist
```

[`rules/lint.json`](rules/lint.json) sets forbidden strings, required dependency links, and the sources that must pass `lint-skill` in staging. `npm run check` lints every generated skill. `npm test` runs the host-neutral tests once. Only `test/extension.test.ts` and `test/roles.test.ts` run both with `T3_MCP_URL` unset and with a test URL. The [root gate](../../README.md#develop-and-verify) also runs the nested packages' suites. For live host verification, follow [Verify host compatibility](docs/landing/t3-settings.md#verify-host-compatibility).

## Updating upstream

`npm run sync` checks out the recorded pins and regenerates. `npm run bump -- <source> [ref]` moves the **checkout**, not just that source's subtree. Before fetching, it requires the entire selected checkout and every other consumed upstream subtree to be clean. The check includes ignored files, file modes, and `skip-worktree` and `assume-unchanged` flags. Generation uses the same check on each input subtree. Preserve local work elsewhere and keep writers out during generation.

For a changed pin, the bump report classifies paths for **every source sharing that checkout**, including both `cursor-plugins` and `owner-plugins` in `vendor/pstack`. Inspect `review scope` paths and borrowed references before accepting the delta. If a previous run already moved the checkout, recover the change with `git -C <checkout> diff --name-status <old-pin> HEAD` using the base gitlink.

Review `git diff -- skills agents` for changes in behavior. Stage the authorized gitlink before `--check`, which compares submodule HEAD with the index. Commit the gitlink, generated files, pin metadata, rule repairs, and [one bump note per PR](docs/bumps/README.md) together.

## Evals

The offline description lint in `npm run check` covers the registry's model-invoked skills and the nested subagents skills visible to Pi. It prints coverage and the rank-1 denominator. Unknown case skills or missing positives fail unless explicitly listed in `test/static-routing/cases.json` under `pending`. Unknown negative owners and an empty scored set fail. Check the label and rubric before editing a description.

For an authorized live run, give `eval:routing` or `eval:behavior` a **read-only source** of disposable credentials and configuration with `--agent-dir` or `P3STACK_EVAL_AGENT_DIR`. Each attempt gets a fresh private Pi agent directory. The runners check real paths against live agent directories, strip repository-local Git variables, and write receipts under `test/eval-output/` by default. Exit 1 means a graded failure. Exit 2 means the run was invalid, not a score.

Routing grades the ordered prefix of successful skill and playbook reads, not whether the model reached the read limit. Behavior grades fixture outcomes separately from process evidence. Only the outcome score determines a pass. See the [eval guide and decision log](../../docs/evals/README.md) for spend approval and past results.
