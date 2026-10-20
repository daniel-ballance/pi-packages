# Retired pistack upstream update of 2026-10-18

> Retired by the one-package consolidation. See [About p3stack](p3stack.md) for current maintenance. The update record below is historical.

## Source review

Advance `cursor/plugins` from `101b274dd991f694e1f7024be2157e5f3adf07de`
to `0b8e952052d482ee6de06deebf14d590d77b1b34`, the fetched `main` tip.
pstack moves from **0.15.25 to 0.15.26**. The updater was given the full SHA.

Reviewed all eight commits touching canonical `pstack/`, their complete file
lists, the canonical diff, and the upstream harness generator/docs checker:

- `0317eb8` (#700): construct TypeScript brands through validating type guards,
  not assertions; preserve the new example unchanged.
- `a968159` (#702): normalize skill frontmatter names to their directories.
  Upstream now supplies `name: poteto-mode`; our old translation is redundant.
  The other changed skill, `make-bot-ui`, remains explicitly excluded.
- `1b80080` (#705): Claude Code packaging now includes the guide/README, stores
  model choices in Claude rules, and defines Cursor-only feature skips. These
  are not Pi/T3 contracts and stay outside the manifest's emit scope.
- `019a6a2` (#704): guide/README prose updates and a tree-based docs checker.
  Review these as upstream references, not generated Pi skills.
- `16541c6` (#692) and `bc14437` (#708): ketchup enumerates every waiting item,
  with evidence, user impact, recommendation and risk; a word limit must not
  replace the list with a count or link. Help reflects the new contract.
- `4382e68` (#709): add `create-formal-verification-skill` and its help route.
  It requires code-grounded scope, mutation checks, explicit findings, and a
  reusable project skill; it does not authorize product-code fixes.
- `0b8e952` (#710): plugin version bump.

Other commits add unrelated third-party plugins. Continue reading canonical
`pstack/`, not the generated `harness/pstack/claude-code/` tree. Every changed
source path reported as `not emitted; review scope` was reviewed; no manifest
expansion beyond the automatically included new skill is needed.

## Deterministic ingestion

The first update stopped at `token rule mode-name: 0 matches`, without changing
generated output. Removed that obsolete rule rather than weakening its tripwire.
All other section hashes and patches still apply unchanged.

The hardcoded slash-command list would have missed the new formal-verification
command. The final token rule now uses `{{skills.names}}`, expanded from emitted
`skills/<name>/SKILL.md` paths before extras are added. Names are regex-escaped
and code-unit sorted; an empty inventory never matches. Excluded skills and
unknown principle names are not translated. Existing path/URL/already-translated
command guards stay unchanged. The maintainer guide documents the expansion and
the upstream-fixed-translation case.

Added two fixture regressions. The new-skill test fails on the baseline pipeline
and passes with the change; it covers a new command in its own skill, another
skill and an agent recipe, a real principle, exclusions, unknown commands,
URLs/paths and suffix boundaries. The empty-inventory test guards the fallback.
The existing updater tests still cover scope reporting, renames, backward pins,
dirty checkouts and failure without output writes.

A scoped token rule places formal-verification output in Pi's discoverable
`.pi/skills/verify-<area>/SKILL.md`, just as the existing app-verification skill
names its Pi destination. Apart from that path and its command spelling, the
new skill is upstream text. Generated output is never hand-edited.

## Manual validation

- Compared every generated change with its canonical upstream source. The
  expected semantic delta is the new formal skill, ketchup, TypeScript guidance,
  and help routing; the other help changes are seven pinned guide URLs. Existing
  poteto-mode, playbooks, agents, scripts and license remain byte-identical.
- Followed the formal skill on a disposable queue fixture. Wrote a discoverable
  `verify-queue` skill and a Node 22.19.0 checker executing the actual generator
  function over all six interleavings of two callers and two atomic segments.
  The baseline passed. Moving reservation after the yield made the same check
  fail on four schedules, including `A B A B`; restoring source passed again.
  The generated skill linted with zero errors/warnings and explicitly states
  its bounds, assumptions, code mapping, rerun command and maintenance trigger.
  This is bounded smoke evidence, not an unbounded proof or a verification of
  production queue behavior. No product source was changed.
- Extracted the new branded-type example, supplied its illustrative `isUUID`
  predicate, and compiled under strict TypeScript. An unchecked string is a
  compile-time error; a valid ID passed and invalid input threw at runtime.
- Re-inventoried all skills, invocation flags and playbooks, and inspected the
  Pocock dependencies and pistack pointers. The new skill is user-invoked and
  changes none of the eleven coverage verdicts; settings/filters stay unchanged.
  `skill-report.mjs --check` passes for home and the update worktree. Those live
  package settings still refer to the main checkout; root packaging tests
  separately load the candidate collection/package, including the new skill,
  and check that pistack's `tdd` wins without skill diagnostics. Fresh
  conversational CLI/T3 prompt lists were not exercised.
- Independent Claude Opus 5.5 review approved the source/output translation,
  generator change and semantic boundaries with no blockers. Its optional
  suggestion to name the new skill's Pi output location was implemented.

## Final gates

- Offline Claude Sonnet 5.5 invocation of the candidate ketchup skill on a
  thirty-item synthetic snapshot produced **30 unique item bullets**, retained
  each decision instead of enforcing the old 150-word ceiling (703 words), and
  preserved the exceptional hold on #104. No links or live PRs were invented.
  This is a single conversational smoke test, not a reliability benchmark.
- A fresh Claude Opus 5.5 follow-up review approved the final path translation,
  generated fidelity, coverage notes and evidence with no blockers. Both review
  rounds were independent delegated tasks; all suggestions are resolved.
- Repeated generation is byte-identical; `generate.mjs --check` and
  `git diff --check` pass. No lockfile or dependency changes are needed.
- **npm:** the full canonical `./scripts/check.sh` passed with Node **22.19.0**
  and the locked workspace install/security step.
- **pnpm 12.6.0:** a separate `.pi/worktrees/verify-pistack-refresh-pnpm`
  checkout of the same candidate passed its frozen install/security step and
  full `./scripts/check.sh` on Node **22.19.0**, with
  `PACKAGE_MANAGER=pnpm PI_PACKAGING_NPM_OFFLINE=false`, matching CI.

Both gates include generated drift, coupling/skill lint, typechecks, package and
upstream helper tests, host variants, real Pi resource loading and production
packaging. Publication uses the committed pre-push hook; no check is bypassed.
