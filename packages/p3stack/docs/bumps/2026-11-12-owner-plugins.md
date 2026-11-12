# Owner plugins bump on 2026-11-12

## Pins

- Source: `owner-plugins`, upstream `cursor/plugins`.
- Shared checkout: `vendor/pstack`, owned by `cursor-plugins` and `owner-plugins`. Both use one candidate and one PR.
- Old SHA: `5866df557357d005b3c0c9d3da0d9e739b4bdde3`.
- New SHA: `a5539b15a3d56e04992565aafee2b37051329ce3`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/5866df557357d005b3c0c9d3da0d9e739b4bdde3...a5539b15a3d56e04992565aafee2b37051329ce3).
- [Shared maintenance PR](https://github.com/daniel-ballance/pi-packages/pull/122).

## Upstream scope

- The shared candidate's commits change only third-party plugins and the marketplace catalog. The [Cursor note](2026-11-12-cursor-plugins.md) lists them.
- Neither `dyl-stack/` nor `thermos/` changed (`git diff --name-status` over both is empty). The second bump reported the checkout already at the candidate.

## Decisions

- No new, renamed, removed, or behavior-changing owner skill. No registry, token, section, patch, route, chain, or deny-token change.

## Generated changes

- The README pin for `owner-plugins` moves to the candidate. No owner skill or agent output changed.

## Verification

Shared with the Cursor note. Routing eval skipped because routes and chains did not change.

## Follow-up

None.
