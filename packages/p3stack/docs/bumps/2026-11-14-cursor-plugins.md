# Cursor plugins bump on 2026-11-14

## Pins

- Source: `cursor-plugins`, upstream `cursor/plugins`.
- Shared checkout: `vendor/pstack`, owned by `cursor-plugins` and `owner-plugins`. Both use one candidate and one PR.
- Old SHA: `24621dbcc59e205a7faadb0e06d540f91712b5cc`.
- New SHA: `3dbd22ff12742fb28c9700b9760baa29ed41dc13`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/24621dbcc59e205a7faadb0e06d540f91712b5cc...3dbd22ff12742fb28c9700b9760baa29ed41dc13).
- [Shared maintenance PR](https://github.com/daniel-ballance/pi-packages/pull/126).

## Upstream scope

- Four upstream commits (two merges) change only third-party plugins and the marketplace catalog: `3dbd22f`, `1b1ed88`, `05b4917`, `c427fa1`.
- Added: `third_party/runta` and `third_party/squarespace`. Edited: `.cursor-plugin/marketplace.json` and the root `README.md` catalog rows.
- Nothing under `pstack/` changed (`git diff --name-status` over `pstack` is empty). The scope report lists no review-scope or borrowed path.

## Decisions

- No new, renamed, removed, or behavior-changing pstack skill. No registry, token, section, patch, route, chain, or deny-token change.
- The packaging changes outside `pstack/` do not reach any mapped path.

## Generated changes

- Only the pinned commit in upstream links changes: `packages/p3stack/README.md`, `packages/p3stack/package.json`, and the guide links in `skills/poteto-help/SKILL.md`. No other skill or agent output changed.
- The second generation produced a diff identical to the first.

## Verification

See the PR body for the gate results. The current-pins root gate, `generate.mjs --check`, the registry check (`0 unclassified`), the static T3 pin check, the loader check, and the fresh-process smoke with `--model claude-subscription/claude-sonnet-5-5:high` passed before the bump. Live T3 catalog check: `orchestrator_capabilities` returned the required tools; `/p3stack doctor` is a Pi slash command and was not run. Routing eval skipped because routes and chains did not change.

## Follow-up

None.
