# Cursor plugins bump on 2026-11-10

## Pins

- Source: `cursor-plugins`, upstream `cursor/plugins`.
- Shared checkout: `vendor/pstack`, owned by `cursor-plugins` and `owner-plugins`. Both use one candidate and one PR.
- Old SHA: `6b0300214a09fd6029cfb7077043125758cd1fd2`.
- New SHA: `de8ee15dd1194627d21eb5fcd41cb1873208dabb`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/6b0300214a09fd6029cfb7077043125758cd1fd2...de8ee15dd1194627d21eb5fcd41cb1873208dabb).
- [Shared maintenance PR](https://github.com/daniel-ballance/pi-packages/pull/117).

## Upstream scope

- Eight upstream commits (four merges) change only third-party plugins and the marketplace catalog: `de8ee15`, `62670fc`, `1e9c3f4`, `62c837e`, `0bb6f37`, `36f8c1a`, `236e548`, `b2a4925`.
- Added: `third_party/google-analytics`, `third_party/metricool`, `third_party/mixpanel`. Renamed: `third_party/databricks-genie-one` to `third_party/databricks-genie`. Edited: `.cursor-plugin/marketplace.json` and the root `README.md` catalog rows.
- Nothing under `pstack/` changed (`git diff --name-status` over `pstack` is empty). The scope report lists no review-scope or borrowed path.

## Decisions

- No new, renamed, removed, or behavior-changing pstack skill. No registry, token, section, patch, route, chain, or deny-token change.
- The packaging changes outside `pstack/` do not reach any mapped path.

## Generated changes

- Only the pinned commit in upstream links changes: `packages/p3stack/README.md`, `packages/p3stack/package.json`, and the guide links in `skills/poteto-help/SKILL.md`. No other skill or agent output changed.
- The second generation produced a diff identical to the first.

## Verification

Passed with exit code 0 each: the current-pins root gate (`Root check passed.`), `generate.mjs --check`, the registry check (`0 unclassified`), the static T3 pin check, package check, package tests, the loader check (`pi list` shows the checkout), the fresh-process smoke with `--model claude-subscription/claude-sonnet-5-5:high` (reply `p3stack smoke ok`, no diagnostics), and the final root gate. Live T3 catalog check: `orchestrator_capabilities` returned the required tools; `/p3stack doctor` is a Pi slash command and was not run. Routing eval skipped because routes and chains did not change.

## Follow-up

None.
