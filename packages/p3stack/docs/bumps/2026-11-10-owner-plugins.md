# Owner plugins bump on 2026-11-10

## Pins

- Source: `owner-plugins`, upstream `cursor/plugins`.
- Shared checkout: `vendor/pstack`, owned by `cursor-plugins` and `owner-plugins`. Both use one candidate and one PR.
- Old SHA: `6b0300214a09fd6029cfb7077043125758cd1fd2`.
- New SHA: `de8ee15dd1194627d21eb5fcd41cb1873208dabb`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/6b0300214a09fd6029cfb7077043125758cd1fd2...de8ee15dd1194627d21eb5fcd41cb1873208dabb).
- [Shared maintenance PR](https://github.com/daniel-ballance/pi-packages/pull/117).

## Upstream scope

- The shared candidate's commits change only third-party plugins and the marketplace catalog. The [Cursor note](2026-11-10-cursor-plugins.md) lists them.
- Neither `dyl-stack/` nor `thermos/` changed (`git diff --name-status` over both is empty). The second bump reported the checkout already at the candidate.

## Decisions

- No new, renamed, removed, or behavior-changing owner skill. No registry, token, section, patch, route, chain, or deny-token change.

## Generated changes

- The README pin for `owner-plugins` moves to the candidate. No owner skill or agent output changed.

## Verification

Shared with the Cursor note: the current-pin and final root gates, package check and tests, registry, static T3 check, loader, and fresh-process smoke all passed. Routing eval skipped because routes and chains did not change.

## Follow-up

None.
