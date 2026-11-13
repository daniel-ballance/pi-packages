# Owner plugins bump on 2026-11-13

## Pins

- Source: `owner-plugins`, upstream `cursor/plugins`.
- Shared checkout: `vendor/pstack`, owned by `cursor-plugins` and `owner-plugins`. Both use one candidate and one PR.
- Old SHA: `a5539b15a3d56e04992565aafee2b37051329ce3`.
- New SHA: `24621dbcc59e205a7faadb0e06d540f91712b5cc`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/a5539b15a3d56e04992565aafee2b37051329ce3...24621dbcc59e205a7faadb0e06d540f91712b5cc).
- [Shared maintenance PR](https://github.com/daniel-ballance/pi-packages/pull/124).

## Upstream scope

- The shared candidate's commits change only third-party plugins and the marketplace catalog. The [Cursor note](2026-11-13-cursor-plugins.md) lists them.
- Neither `dyl-stack/` nor `thermos/` changed (`git diff --name-status` over both is empty). The second bump reported the checkout already at the candidate.

## Decisions

- No new, renamed, removed, or behavior-changing owner skill. No registry, token, section, patch, route, chain, or deny-token change.

## Generated changes

- The README pin for `owner-plugins` moves to the candidate. No owner skill or agent output changed.

## Verification

Shared with the Cursor note. Routing eval skipped because routes and chains did not change.

## Follow-up

None.
