# p3stack

The Pi edition of Cursor's pstack, **generated** from the vendored upstream.
`skills/`, `LICENSE`, and `LICENSE-matt-pocock` are generated output. Never edit them by hand: change a
rule and regenerate. The package check fails on drift.

Design and decisions: [`docs/p3stack-design.md`](../../docs/p3stack-design.md)
(§4.0 is the generator).

## Inputs and outputs

| Path | Kind | Owner |
|---|---|---|
| `vendor/pstack` | git submodule, `cursor/plugins`; pstack, dyl-stack, and thermos | upstream |
| `vendor/matt-pocock` | git submodule, `mattpocock/skills` | upstream |
| `registry/` | skill verdicts, emitted names, invocation, routes, and chains | hand-written |
| `rules/manifest.json` | named sources with their vendor roots, path maps, resource exclusions, and upstream checkouts | hand-written |
| `rules/tokens.json` | token rewrites | hand-written |
| `rules/sections.json` + `overlays/` | section replacements | hand-written |
| `patches/*.patch` | per-file patches, the escape hatch | hand-written |
| `rules/lint.json` | coupling lint deny-list | hand-written |
| `extra/` | Pi-native files added to the output as they are | hand-written |
| `authored/` | p3stack-owned skills and playbooks copied after `extra/` | hand-written |
| `generator/` | the generator, the upstream updater and the lint wrapper | hand-written |
| `extensions/p3stack/` | mode toggle, `ask_user`, `p3stack_roles`, `/p3stack-setup` | hand-written |
| `skills/`, `LICENSE`, `LICENSE-matt-pocock` | generated | `generator/generate.mjs` |

## Commands

```sh
npm run generate                      # regenerate skills/ and LICENSE
npm run generate -- --check            # fail on drift; writes nothing
npm run bump -- <source> [ref]         # move one source pin and regenerate
npm run check                         # drift check, then lint-skill on every skill
npm test                              # generator tests on fixtures
```

`npm run check` runs the repository's `lint-skill` from `../../scripts/lint-skill`,
so install the workspace first.

## Sources and rules

`rules/manifest.json` contains a `sources` array. Each source has a unique `name`,
a `vendor` root, a `map` of input prefixes to output prefixes, an optional
`exclude` list of regular expressions, and optional `upstream` checkout details.
The sources are `cursor-plugins`, `matt-pocock`, and `owner-plugins`. The owner
source reads dyl-stack and thermos from the same Cursor checkout, with no new pin.
A source's optional `required` list names output paths that it must supply.
`registry/skills.json` classifies every upstream skill under each source's
`skillRoots`, which defaults to `skills/`. Drop rows exclude the whole skill
directory. Emit rows own the output name and invocation. Resource exclusions
remain in the manifest. pstack's `tdd` becomes `regression-test`; Pocock keeps `tdd`.
`node generator/check-registry.mjs` checks coverage, unique names, route and chain
targets, and exact chain anchors. Generation checks these before replacing output.
If two sources emit the same path, generation fails with the path and both names
before it writes output.

Rules apply in this order. The same sources and rules give byte-identical output.

1. **Token rewrites** (`rules/tokens.json`) use `{id, min, find, flags?, replace, files?, source?}`.
   `find` is a JavaScript regular expression and `replace` may use `$1`.
   `files` limits the rule to output paths matching a regular expression.
   `source` limits it to files from that named source. Without `source`, the rule
   applies to all sources. `min` counts matches only within the selected scope.
   Rules apply in order, so a later rule sees an earlier rule's output. A rule
   with fewer matches than `min` fails generation with its id.
   In `find`, `{{skills.names}}` expands to
   a regex alternation of the emitted `skills/<name>/SKILL.md` directory names,
   escaped and sorted in code-unit order. The final slash-command rule uses it
   so new upstream skills get Pi commands without maintaining a second list.
2. **Section replacements** (`rules/sections.json`): `{file, heading,
   upstreamHeading?, overlay, upstream}`. `heading` is the line as it reads after
   token rewrites; `upstreamHeading` is the raw upstream line when a token rule
   changed it. The section runs from the exact heading line to the next heading
   of the same or a higher level. The overlay replaces it whole, heading
   included, and only when that upstream section is a leaf: a child heading
   outside a fence fails generation even when the hash still matches. The message
   names the file, the heading, and each child. Replace each child. Put text
   before the first child in a token anchored on the heading. A sibling with no
   rule is emitted. `upstream` is the first 12 hex digits of the SHA-256 of the
   untranslated upstream section; when upstream edits the section, generation
   fails with the new hash. Review the overlay against the upstream change, then
   update the hash. A heading that disappears fails with its file and text.
3. **Patches** (`patches/*.patch`, applied in name order): unified diffs against
   the output of the first two kinds, paths `a/skills/...`. A patch that no
   longer applies fails with its name; rebase it. Keep patches rare: prefer a
   token or a section.

`extra/` files are added after tokens and sections but before patches and are
not rewritten by token or section rules.
`authored/` files are copied after `extra/` without rewrites. Register each authored
skill as `source: "p3stack"` with its path relative to `authored/`. Its frontmatter
must match the registry name and invocation. The
**coupling lint** then scans every emitted file for the tokens in
`rules/lint.json` and fails with `file:line: token`. The fix is always a new or
corrected rule, never an edit to the output. `lint.json` also requires dependency
links through `require` entries with `file` and `contains` fields. `resources`
names the sources whose staged skills must pass the repository's `lint-skill`
before generation replaces committed output. A missing linter refuses replacement.
The Pocock source keeps its former staged validation. `npm run check` lints every skill.

## Helper scripts

Upstream's scripts under `skills/poteto-mode/scripts/` target Bun. Token rules
turn them into Node scripts that Node 22.19's built-in type stripping runs:
shebangs, `import.meta.dir`/`main`, the dependency bootstrap (dropped; `commander`
is a package dependency), and `bun:test` imports, which point at the hand-written
shims `extra/skills/poteto-mode/scripts/bun-test.ts` (Bun's `expect` on
`node:test`) and `bun-compat.ts` (`Bun.spawn`/`spawnSync`). Code Node cannot strip
(a TypeScript parameter property) gets a rule that rewrites it to erasable
syntax. `worktree-audit.sh` is the one patch: it reads Pi sessions instead of
Cursor transcripts and runs on Linux as well as macOS. `npm test` runs upstream's
own script tests; `npm run check` typechecks `watch-pr`.

## Writing rules

- Skills name capabilities, never backend tools. Map a Cursor mechanism to a
  capability in [`extra/skills/poteto-mode/references/host-capabilities.md`](extra/skills/poteto-mode/references/host-capabilities.md)
  and link that file; keep tool names for both hosts in that one place.
- Prefer a sentence-level token rule scoped with `files` over a section
  replacement: untouched upstream sentences around it keep flowing in. A section
  rule names a leaf heading, never a parent that has children.
- A recurring upstream sentence gets one global rule, not one per skill.
- Never write an upstream commit into a rule. A link into upstream uses
  `{{upstream.commit}}` in a token `replace` or an overlay, and the generator
  fills in that file's source commit. The README states all source pins between
  `<!-- p3stack:upstream -->` markers, which the generator rewrites.
- Default model hints such as `claude-opus-5-5-xhigh` stay as written; the
  capabilities reference explains how to resolve them on Pi.
- A file-specific rule must come before any global rule that rewrites part of
  its text; the slash-command rule (`/name` to `/skill:name`) runs last.
- Write links relative to the skill directory, not the file: Pi resolves a
  skill's relative paths from its directory (`docs/skills.md`), and `lint-skill`
  checks them the same way. From `skills/poteto-mode/playbooks/x.md` the
  capabilities reference is `references/host-capabilities.md`.
- `lint-skill` warnings about orphan resources are expected: upstream reaches
  playbooks and references by naming convention. Errors fail the check.

## Maintain p3stack

Use [`maintain-p3stack`](authored/skills/maintain-p3stack/SKILL.md) for current-pin audits and upstream refreshes. Its audit stops with one status per vendored source and creates no PR. An explicit bump request continues to source updates, generator repairs, and unmerged PRs. Keep shared-checkout sources in one PR and independent sources separate.

Write changed-source notes in [`docs/bumps/`](docs/bumps/README.md). Keep dependency refreshes and T3 host-contract repairs separate. Use disposable Pi settings for loader checks and smoke tests. The skill does not change the live agent configuration or install tools.

## Updating upstream

Generation and `--check` require clean inputs under `vendor/pstack/pstack`,
including ignored files, executable-bit changes, and `plugin.json`. The status
probe forces `core.fileMode=true` without changing the clone's configuration.
They also reject `skip-worktree` and
`assume-unchanged` index flags, which can hide edits from Git status. The error
lists the paths. Preserve local work elsewhere, then restore the vendored source
and clear those flags before regenerating. Keep upstream edits out of the
checkout while generation runs. This check is not a snapshot or a lock against
concurrent writers. Local rules, overlays, patches, and extras remain editable.

```sh
npm run bump -- cursor-plugins        # the tip of upstream main
npm run bump -- cursor-plugins <ref>  # or a commit or tag
npm run bump -- matt-pocock <ref>     # update the Pocock source
```

The command requires a source name. It fetches only that source's checkout,
moves it to the ref, and classifies changed paths against that source's map and
exclusions before it regenerates all sources. `cursor-plugins` uses `vendor/pstack`
and the `pstack/` subtree. `owner-plugins` uses that same checkout's sibling trees. Unknown names and dirty checkouts fail before a fetch.
`npm run update-upstream -- <source> [ref]` remains an alias.
The report distinguishes emitted paths, explicit exclusions, and paths not emitted. Review every path marked `review scope`: it may be a new
capability the manifest does not yet include. `plugin.json` is not emitted but
supplies the plugin name and version. Inspect the full upstream commits too
(`git -C vendor/pstack show --stat <sha>`); packaging can live outside
`pstack/`. Use the canonical `pstack/` sources, not upstream's generated
`harness/pstack/` copies for other hosts. If a failed update or a rerun already
moved the checkout, recover its source delta with
`git -C vendor/pstack diff --name-status <old-pin> HEAD -- pstack`.
The old pin is in the base branch's package metadata.

Generation records every source pin between the README markers. Sources with
`plugin.json` also include the plugin name and version. The `cursor-plugins` pin
stays in `package.json` as `p3stack.upstream`. `{{upstream.commit}}` expands to
the source commit of the file a token rule or section overlay rewrites.

`--check` compares every submodule checkout with its staged gitlink and checks
all README pins. Standalone source clones have no gitlink to compare. The check
also checks `p3stack.upstream` for `cursor-plugins` and reports the generated file
and byte counts on success. It writes nothing.

When it fails, each line names a token rule, section or patch upstream no
longer fits, and the checkout stays at the new commit. Read the upstream commit
that broke it (`git -C vendor/pstack show <sha>`), then fix the rule:

- **Token rule, 0 matches**: upstream reworded the text, so update `find`; or
  upstream deleted it or now supplies the translated form, so delete the rule.
  If the rule added Pi-specific meaning, decide whether that meaning still
  belongs somewhere.
- **Section changed upstream**: review the overlay against the upstream change,
  then set the new hash the message prints. If the message says the section is
  not a leaf, do not bump the hash. Split it into child overlays, or anchor
  preamble text with a token. A new sibling with no rule is already emitted;
  read it, and add a rule only when it needs Pi text.
- **Patch no longer applies**: rebase it against the new output.
- **Coupling lint**: upstream added Cursor-only text; add a rule.

Rerun `node generator/generate.mjs` until it passes, then review
`git diff -- skills agents` for upstream changing a decision, not just a
sentence. Regenerate a second time and confirm the diff is unchanged.
Classify every new or renamed upstream skill in `registry/skills.json`.
The checker names unclassified paths and stale rows. Keep a reason for each drop.
Run `npm run check`, `npm test`, and the repository's `./scripts/check.sh`
before committing `vendor/pstack` with the regenerated output and rule changes.
