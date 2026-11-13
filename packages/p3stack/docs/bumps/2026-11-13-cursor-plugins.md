# Cursor plugins bump on 2026-11-13

## Pins

- Source: `cursor-plugins`, upstream `cursor/plugins`.
- Shared checkout: `vendor/pstack`, owned by `cursor-plugins` and `owner-plugins`. Both use one candidate and one PR.
- Old SHA: `a5539b15a3d56e04992565aafee2b37051329ce3`.
- New SHA: `24621dbcc59e205a7faadb0e06d540f91712b5cc`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/a5539b15a3d56e04992565aafee2b37051329ce3...24621dbcc59e205a7faadb0e06d540f91712b5cc).
- [Shared maintenance PR](https://github.com/daniel-ballance/pi-packages/pull/124).

## Upstream scope

- Six upstream commits (three merges) change only third-party plugins and the marketplace catalog: `24621db`, `e98cb1b`, `6e359ce`, `3534363`, `ec56937`, `57cfb2e`.
- Added: `third_party/engine` and `third_party/paypal`. Edited: `third_party/rippling` (one line in its plugin manifest), `.cursor-plugin/marketplace.json` and the root `README.md` catalog rows.
- Nothing under `pstack/` changed (`git diff --name-status` over `pstack` is empty). The scope report lists no review-scope or borrowed path.

## Decisions

- No new, renamed, removed, or behavior-changing pstack skill. No registry, token, section, patch, route, chain, or deny-token change.
- The packaging changes outside `pstack/` do not reach any mapped path.

## Generated changes

- Only the pinned commit in upstream links changes: `packages/p3stack/README.md`, `packages/p3stack/package.json`, and the guide links in `skills/poteto-help/SKILL.md`. No other skill or agent output changed.
- The second generation produced a diff identical to the first.

## Verification

See the PR body for the gate results. The current-pins root gate, `generate.mjs --check`, the registry check (`0 unclassified`), the static T3 pin check, the loader check, and the fresh-process smoke with `--model claude-subscription/claude-sonnet-5-5:high` passed before the bump. Live T3 catalog check: `orchestrator_capabilities` returned the required tools; `/p3stack doctor` is a Pi slash command and was not run. Routing eval skipped because routes and chains did not change. The bump needed retries after GitHub returned HTTP 429 on anonymous git requests.

## Follow-up

None.
