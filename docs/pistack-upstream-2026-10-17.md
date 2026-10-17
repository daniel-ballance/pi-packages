# pistack upstream update — 2026-10-17

## Source review

Advance `cursor/plugins` from `f713f14203cd6420cec13cd7c55c32d598dbab68`
to `101b274dd991f694e1f7024be2157e5f3adf07de` (the fetched `main` tip).
pstack's plugin version remains **0.15.25**.

There are 21 upstream commits in this range, but only
[`182f2ce` (#637)](https://github.com/cursor/plugins/commit/182f2ce414e83224915c190d2f63239c1608d0a5)
touches canonical `pstack/`:

- `pstack/README.md` documents Claude Code installation and clarifies that
  Benny is Cursor-only.
- `pstack/docs/harness/claude-code.md` adds Claude Code's capability adapter.
- Outside `pstack/`, the same commit adds generated `harness/pstack/claude-code/`
  output, its generator, marketplace registration, and validation wiring.

Reviewed the canonical diff, the full commit's file list, its generator and
adapter. `git diff f713f14 101b274 -- pstack/skills pstack/agents
pstack/LICENSE pstack/plugin.json` is empty. Other commits change unrelated
plugins. The manifest correctly continues to read canonical `pstack/`, not the
generated Claude tree. The new adapter is not a Pi/T3 capability change and
should not be imported. Existing exclusions and translation rules need no edits.

## Update and ingestion improvement

Ran the updater with the full target SHA. The generated delta is exactly seven
pinned guide URLs in `poteto-help`, the package/README pin, and the submodule
pointer. No generated files were hand-edited; no agent, executable, skill name,
invocation flag, playbook, or license changed.

The updater now reports each changed source path's manifest disposition:
emitted destination, explicit exclusion, or **not emitted; review scope**.
Generation and reporting share one classifier, so their scope cannot diverge.
Both real changed paths were reported as not emitted and manually reviewed.
The report also directs maintainers to inspect full commits for packaging
outside the canonical subtree. The maintainer guide records this review and
repeat-generation process.

## Validation

- Two new end-to-end fixture tests failed before implementation, then passed.
  They cover emitted/excluded/unmapped additions, unrelated-plugin filtering,
  no-op repeats, rename deletion/addition pairs, and explicit backward pins.
  All 30 generator, Git-environment, and updater tests pass.
- Ran generation twice; the full tracked binary diff before/after the repeat
  was identical. `generate.mjs --check` and `git diff --check` pass.
- Compared generated changes with canonical upstream changes manually. An
  independent Claude Opus 5.5 review approved with no blockers and confirmed
  scope classification and the source/output comparison. Its reminder to stage
  the new classifier was satisfied; cosmetic suggestions were not necessary.
- Re-inventoried both skill collections and checked cross-package pointers:
  names and invocation flags are byte-identical to the baseline, so all eleven
  Pocock coverage verdicts stay unchanged. `skill-report.mjs --check` passes
  for home and the update worktree. Those live settings still point to the main
  checkout; the root package-loader tests separately load the candidate tree
  and assert that pistack's `tdd` wins without diagnostics. Fresh conversational
  CLI/T3 sessions were not repeated for this URL/pin-only generated delta.
- **npm:** `./scripts/check.sh` passed under Node **22.19.0**, after the locked
  install and explicit Pi SDK security step.
- **pnpm 12.6.0:** a separate `.pi/worktrees/verify-pistack-pnpm` checkout of the
  staged candidate passed the frozen install/security step and the full
  `./scripts/check.sh` under Node **22.19.0**, with
  `PACKAGE_MANAGER=pnpm PI_PACKAGING_NPM_OFFLINE=false` as in CI. This includes
  the pnpm production-install packaging fixture. Lockfiles are unchanged.

Local CI includes generated drift, coupling/skill lint, typechecks, upstream
helper-script tests, host variants, and real Pi resource/production-package
loading. These results establish a packaging-only upstream update; they do not
claim that Claude Code's new adapter was exercised as a supported pistack host.
