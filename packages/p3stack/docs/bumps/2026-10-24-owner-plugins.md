# owner-plugins bump on 2026-10-24

## Pins

- Source: `owner-plugins`, upstream `cursor/plugins`.
- Checkout: `vendor/pstack`, shared with `cursor-plugins`. Both use [maintenance PR #76](https://github.com/daniel-ballance/pi-packages/pull/76).
- Audited original pin: `88d47514b82e7c44f00f2b2a72ff6dd12158038c`.
- Previous PR candidate: `8b3326d99fd4b993cb33a24dad8af03175c642c5`.
- New upstream tip: `9580c23696ac8d7abed0c166f2f9918800afb819`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/88d47514b82e7c44f00f2b2a72ff6dd12158038c...9580c23696ac8d7abed0c166f2f9918800afb819).
- Audited base is separate portability [PR #75](https://github.com/daniel-ballance/pi-packages/pull/75), commit `04a2cc918836bb822ecb2836f61d56ce07584285`, now merged as `2b5b44dc49765f628f173e0f2252c24a4ce7249f`.

## Upstream scope

Both shared-source bump commands use the same final candidate. The owner command reports no additional movement. Complete diffs and tree comparisons from the audited original pin find no changes under `dyl-stack/` or `thermos/`, including unmapped files. The [Cursor note](2026-10-24-cursor-plugins.md) and [independent scope review](/tmp/p3stack-maint-46919880/cursor/review/decision-scope.md) account for the checkout's remaining commits and packaging.

## Decisions

Keep all five emitted owner skill rows, maps, token rules, overlays, routes, chains, and tests unchanged. No owner skill is new, renamed, removed, or behavior-changing. No owner min-match or section repair is needed. Keep every deny token.

## Generated changes

Only the README's owner-source pin advances. Owner skill and agent content stays unchanged. The shared generated diff is reproducible, as shown by [generation-identical](/tmp/p3stack-maint-46919880/cursor/generation-identical.exit).

## Verification

Shared candidate receipts are under `/tmp/p3stack-maint-46919880/cursor/`, with complete command, stdout, stderr, and exit-code files.

- The audited current-pin [root gate](/tmp/p3stack-maint-46919880/portability/root.stdout), baseline generation/registry/static-host checks, and [loader smoke](/tmp/p3stack-maint-46919880/baseline-loader/PASS.txt) passed before the bumps.
- Candidate package checks, tests, registry, static host contract, host lint, generator check, and [root gate](/tmp/p3stack-maint-46919880/cursor/root.stdout) passed. The registry reports `87 emitted, 24 dropped, 0 unclassified` and the root ends with `Root check passed.`.
- [Final loader and smoke](/tmp/p3stack-maint-46919880/cursor/final-loader/PASS.txt) passed with explicit `openai-codex/gpt-6.1-sol:xhigh`: local package listed, exact native/T3 replies, no loader errors, live doctor capabilities, and bridge prompt integration.
- Routing eval is skipped because routes and chains are unchanged. The Cursor statechart suite explicitly skips 100 optional TLC/renderer integrations per host pass. No owner coverage is skipped or removed by this update, and no real TLC or PNG success is claimed.
- [Scope review](/tmp/p3stack-maint-46919880/cursor/review/decision-scope.md) found no blockers. The push hook and independent landing verifier must pass on the rebased PR head before merge.

## Follow-up

No separate owner PR, dependency refresh, or host update is needed. The user authorized a continuation of existing #76 to avoid a duplicate, then authorized merging #75 and retargeting/revalidating #76 on main before merge. The owner-review bypass is authorized only after validation passes. Earlier notes retain their historical unmerged state.
