# pistack

The Pi edition of Cursor's pstack, **generated** from the vendored upstream.
`skills/` and `LICENSE` are generated output. Never edit them by hand: change a
rule and regenerate. The package check fails on drift.

Design and decisions: [`docs/pistack-design.md`](../../docs/pistack-design.md)
(§4.0 is the generator).

## Inputs and outputs

| Path | Kind | Owner |
|---|---|---|
| `vendor/pstack` | git submodule, `cursor/plugins`; the generator reads only `pstack/` | upstream |
| `rules/manifest.json` | which upstream paths are emitted, and where | hand-written |
| `rules/tokens.json` | token rewrites | hand-written |
| `rules/sections.json` + `overlays/` | section replacements | hand-written |
| `patches/*.patch` | per-file patches, the escape hatch | hand-written |
| `rules/lint.json` | coupling lint deny-list | hand-written |
| `extra/` | Pi-native files added to the output as they are | hand-written |
| `generator/` | the generator, the upstream updater and the lint wrapper | hand-written |
| `extensions/pistack/` | mode toggle, `ask_user`, `pistack_roles`, `/pistack-setup` | hand-written |
| `skills/`, `LICENSE` | generated | `generator/generate.mjs` |

## Commands

```sh
node generator/generate.mjs           # regenerate skills/ and LICENSE
node generator/generate.mjs --check   # fail on drift; writes nothing
npm run update-upstream [-- <ref>]    # move the upstream pin and regenerate
npm run check                         # drift check, then lint-skill on every skill
npm test                              # generator tests on fixtures
```

`npm run check` runs the repository's `lint-skill` from `../../scripts/lint-skill`,
so install the workspace first.

## Rule kinds

Applied in this order; the same upstream and rules give byte-identical output.

1. **Token rewrites** (`rules/tokens.json`): `{id, min, find, flags?, replace, files?}`.
   `find` is a JavaScript regular expression, `replace` may use `$1`, `files`
   limits the rule to output paths matching a regular expression. Rules count
   then apply in order, so a later rule sees an earlier rule's output. `min` is
   a tripwire: a rule matching fewer times fails generation with its id, which
   means upstream reworded the text. In `find`, `{{skills.names}}` expands to
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

`extra/` files are added after the rule kinds and are not rewritten. The
**coupling lint** then scans every emitted file for the tokens in
`rules/lint.json` and fails with `file:line: token`. The fix is always a new or
corrected rule, never an edit to the output.

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
  fills in the pinned commit. The README states the pin between
  `<!-- pistack:upstream -->` markers, which the generator rewrites.
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

## Updating upstream

```sh
npm run update-upstream             # the tip of upstream main
npm run update-upstream -- <ref>    # or a commit or tag
```

It fetches `vendor/pstack`, moves it to the ref, lists upstream's commits to
`pstack/` and classifies each changed source path against the manifest, then
regenerates. The report distinguishes emitted paths, explicit exclusions, and
paths not emitted. Review every path marked `review scope`: it may be a new
capability the manifest does not yet include. `plugin.json` is not emitted but
supplies the plugin name and version. Inspect the full upstream commits too
(`git -C vendor/pstack show --stat <sha>`); packaging can live outside
`pstack/`. Use the canonical `pstack/` sources, not upstream's generated
`harness/pstack/` copies for other hosts.

Generation records the pin in `package.json`
(`pistack.upstream`) and the README markers and fills `{{upstream.commit}}`;
`--check` fails while any of them disagree with the checkout.

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
Re-check skill coverage with the repository's
[`pistack-pocock-unification` skill](../../.pi/skills/pistack-pocock-unification/SKILL.md).
Run `npm run check`, `npm test`, and the repository's `./scripts/check.sh`
before committing `vendor/pstack` with the regenerated output and rule changes.
