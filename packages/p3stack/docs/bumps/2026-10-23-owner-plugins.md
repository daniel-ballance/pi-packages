# owner-plugins bump on 2026-10-23

## Pins

- Source: `owner-plugins`, upstream `cursor/plugins`.
- Checkout: `vendor/pstack`, shared with `cursor-plugins`. This note records the changed shared source pin, not an owner-content update.
- Old: `88d47514b82e7c44f00f2b2a72ff6dd12158038c`.
- New: `8b3326d99fd4b993cb33a24dad8af03175c642c5`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/88d47514b82e7c44f00f2b2a72ff6dd12158038c...8b3326d99fd4b993cb33a24dad8af03175c642c5).
- Maintenance PR: pending parent creation, the same PR as cursor-plugins. Depends on [unmerged prerequisite #75](https://github.com/daniel-ballance/pi-packages/pull/75), with base `chore/p3stack-portability-602346f4`.

## Upstream scope

The explicit owner bump command uses the same saved candidate as Cursor. It reports no additional movement because both sources share one checkout. Full `diff --name-status` review from the original pin to the candidate finds no changes under `dyl-stack/` or `thermos/`, including their unmapped paths.

The checkout's pstack commits `eb4db2b`, `7698375`, and `4ec7ffa` add and refine statechart. Third-party plugins and packaging outside the owner subtrees do not enter the owner maps. The [Cursor note](2026-10-23-cursor-plugins.md) accounts for that content. [upstream-review.log](/tmp/p3stack-maint-602346f4/cursor/upstream-review.log) contains every commit, stat, full diff, and the empty owner delta. [outside-scope-review.md](/tmp/p3stack-maint-602346f4/cursor/outside-scope-review.md) records the external path decisions.

## Decisions

Keep all five owner skill verdicts, maps, rules, routes, chains, and tests unchanged. No owner skill is new, renamed, removed, or behavior-changing. No min-match or section-hash repair is needed. All deny tokens and rule minima stay unchanged.

## Generated changes

The README owner source marker changes to the shared candidate SHA. The owner skill and agent output stays unchanged. The [generated review receipt](/tmp/p3stack-maint-602346f4/cursor/final-generated-review.log) checks owner output and the unchanged owner rules. Two generations produce identical skills-and-agents diffs, recorded in [generation-identical.log](/tmp/p3stack-maint-602346f4/cursor/generation-identical.log).

## Verification

The shared candidate uses the same acceptance runs as cursor-plugins. Each command has `.command`, `.log`, and `.exit` receipt siblings.

- The inherited [current-pin root gate](/tmp/p3stack-maint-602346f4/audit/root.log) and [loader baseline](/tmp/p3stack-maint-602346f4/audited-loader-retry/PASS.txt) passed before the bump. Audit generation, registry, and host receipts are in the same audit directory.
- Candidate [package check](/tmp/p3stack-maint-602346f4/cursor/package-check.log), [tests](/tmp/p3stack-maint-602346f4/cursor/package-tests.log), [registry](/tmp/p3stack-maint-602346f4/cursor/registry.log), [static host](/tmp/p3stack-maint-602346f4/cursor/static-host.log), [host lint](/tmp/p3stack-maint-602346f4/cursor/lint-hosts.log), and [generator check](/tmp/p3stack-maint-602346f4/cursor/generator-check.log) exit 0. The registry has `0 unclassified`.
- Final [root gate](/tmp/p3stack-maint-602346f4/cursor/root.log) exits 0 with `Root check passed.`. Final [loader and smoke](/tmp/p3stack-maint-602346f4/cursor/final-loader/PASS.txt) verify exact native and T3 replies, clean stderr, the live doctor contract, and bridge prompt integration using `openai-codex/gpt-6.1-sol:xhigh`.
- Routing eval skipped because routes and chains did not change. The new Cursor suite skips 38 TLC-dependent tests per pass because TLC is absent; no owner coverage is skipped or removed by this bump.

## Follow-up

No separate owner PR, dependency refresh, or host-contract repair is needed. The parent owns the shared PR and inserts its returned URL into both notes. The maintenance PR and prerequisite remain unmerged.
