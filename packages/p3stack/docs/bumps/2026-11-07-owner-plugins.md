# Owner plugins bump on 2026-11-07

## Pins

- Source: `owner-plugins`, upstream `cursor/plugins`.
- Shared checkout: `vendor/pstack`, owned by `cursor-plugins` and `owner-plugins`. Both use one candidate and one PR.
- Old SHA: `ae5650febf4320793844c12c4adaa937f417f8da`.
- New SHA: `6b0300214a09fd6029cfb7077043125758cd1fd2`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/ae5650febf4320793844c12c4adaa937f417f8da...6b0300214a09fd6029cfb7077043125758cd1fd2).
- [Shared maintenance PR, by branch](https://github.com/daniel-ballance/pi-packages/pulls?q=is%3Apr+head%3Afeat%2Fintegrate-pstack-pocock-skills).

## Upstream scope

- The shared candidate's 22 commits change only third-party plugins and the marketplace catalog. The [Cursor note](2026-11-07-cursor-plugins.md) lists them.
- Neither `dyl-stack/` nor `thermos/` changed. The [owner source delta](file:///tmp/p3stack-maint-20261107-integrate/owner-source-delta.txt) is empty. The second bump reported the checkout already at the candidate.

## Decisions

- No new, renamed, removed, or behavior-changing owner skill. No registry, token, section, patch, route, chain, or deny-token change.

## Generated changes

- The README pin for `owner-plugins` moves to the candidate. No owner skill or agent output changed.

## Verification

Shared with the Cursor note: the current-pin and final root gates, package check and tests, registry, static and live T3 checks, loader, and fresh-process smoke all passed. Routing eval skipped because routes and chains did not change.

## Follow-up

None for this source. The owner asked for an admin merge of the shared PR.
