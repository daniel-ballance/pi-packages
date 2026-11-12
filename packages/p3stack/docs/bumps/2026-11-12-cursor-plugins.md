# Cursor plugins bump on 2026-11-12

## Pins

- Source: `cursor-plugins`, upstream `cursor/plugins`.
- Shared checkout: `vendor/pstack`, owned by `cursor-plugins` and `owner-plugins`. Both use one candidate and one PR.
- Old SHA: `5866df557357d005b3c0c9d3da0d9e739b4bdde3`.
- New SHA: `a5539b15a3d56e04992565aafee2b37051329ce3`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/5866df557357d005b3c0c9d3da0d9e739b4bdde3...a5539b15a3d56e04992565aafee2b37051329ce3).
- [Shared maintenance PR](https://github.com/daniel-ballance/pi-packages/pull/122).

## Upstream scope

- Six upstream commits (three merges) change only third-party plugins and the marketplace catalog: `a5539b1`, `930deb4`, `0dda7b5`, `a7c7e46`, `2eaf465`, `6e4ac01`.
- Added: `third_party/front` and `third_party/netsuite`. Edited: `third_party/gong`, `.cursor-plugin/marketplace.json` and the root `README.md` catalog rows.
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
