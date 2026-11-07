# Cursor plugins bump on 2026-11-07

## Pins

- Source: `cursor-plugins`, upstream `cursor/plugins`.
- Shared checkout: `vendor/pstack`, owned by `cursor-plugins` and `owner-plugins`. Both use one candidate and one PR.
- Old SHA: `ae5650febf4320793844c12c4adaa937f417f8da`.
- New SHA: `6b0300214a09fd6029cfb7077043125758cd1fd2`, the upstream `main` tip from `git ls-remote`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/ae5650febf4320793844c12c4adaa937f417f8da...6b0300214a09fd6029cfb7077043125758cd1fd2).
- [Maintenance PR, by branch](https://github.com/daniel-ballance/pi-packages/pulls?q=is%3Apr+head%3Afeat%2Fintegrate-pstack-pocock-skills). It supersedes the open maintenance PRs #93 and #94, which pinned older tips.

## Upstream scope

- 22 upstream commits, merged through upstream PRs #1161, #1167, #1168, #1171, #1181, #1185, and #1186. They add the Tesla and FitMetrics third-party plugins, revise the X MCP guide and the X plugin, and update the Tailscale setup skill and README.
- Reviewed every path in the [full upstream diff](file:///tmp/p3stack-maint-20261107-integrate/cursor-upstream.diff), the [file list](file:///tmp/p3stack-maint-20261107-integrate/cursor-upstream-files.txt), and the [commit statistics](file:///tmp/p3stack-maint-20261107-integrate/cursor-upstream-stat.txt).
- Packaging outside `pstack/`: `.cursor-plugin/marketplace.json` and the root README add catalog entries for Tesla and FitMetrics. Every other path is under `third_party/`.
- `pstack/` did not change. The [source delta](file:///tmp/p3stack-maint-20261107-integrate/cursor-source-delta.txt) is empty, and pstack stays at version 0.15.36. The bump reported no `review scope` path.

## Decisions

- No new, renamed, removed, or behavior-changing skill occurs in the mapped scope. The third-party plugins stay outside p3stack's maps.
- Both shared-source bump commands ran at the same candidate. This PR keeps the shared gitlink.
- No registry verdict, token rule, section hash, patch, route, or chain changed. Every lint deny token remains intact.

## Generated changes

- The README source pin and the `p3stack.upstream` package provenance move to the candidate.
- The only skill delta updates seven upstream guide URLs in `poteto-help` to the candidate commit. Skill behavior and agents are unchanged.
- [Second-generation identity](file:///tmp/p3stack-maint-20261107-integrate/regeneration-identity.log) confirms an identical intended diff ([first](file:///tmp/p3stack-maint-20261107-integrate/generated-diff-1.patch), [second](file:///tmp/p3stack-maint-20261107-integrate/generated-diff-2.patch)).

## Verification

- Audited base `c86fd57c83780df8571ed0a49bbb869172c5701f`: [root gate](file:///tmp/p3stack-maint-20261107-integrate/audit-root-check.log), generation check, registry, and static T3 check passed.
- Candidate: [package check](file:///tmp/p3stack-maint-20261107-integrate/pkg-check.log) with 0 errors (105 orphan-resource warnings are expected), [package tests](file:///tmp/p3stack-maint-20261107-integrate/pkg-test.log) with 246 passed and 0 failed, [generation check](file:///tmp/p3stack-maint-20261107-integrate/gen-check.log), [registry](file:///tmp/p3stack-maint-20261107-integrate/registry.log) with `87 emitted, 25 dropped, 0 unclassified`, [static T3 contract](file:///tmp/p3stack-maint-20261107-integrate/t3-static.log), and [host lint](file:///tmp/p3stack-maint-20261107-integrate/host-lint.log) passed.
- [Final root gate](file:///tmp/p3stack-maint-20261107-integrate/final-root-check.log) ended with `Root check passed.`.
- Live under T3 0.1.7 with installed Pi 1.5.0 and `claude-subscription/claude-opus-5-5:high`: the [doctor dump](file:///tmp/p3stack-maint-20261107-integrate/final-t3-contract.json) passed `check-t3-pin.mjs --doctor`, the [loader](file:///tmp/p3stack-maint-20261107-integrate/final-loader.log) listed the local package, and the [fresh-process smoke](file:///tmp/p3stack-maint-20261107-integrate/final-smoke.jsonl) replied exactly `p3stack smoke ok` with no loader diagnostics. The [host review](file:///tmp/p3stack-maint-20261107-integrate/host-review.md) records the live catalog and role resolution.
- Routing eval skipped because routes and chains did not change.

## Follow-up

- `p3stack_roles` resolves models but no thinking option under T3. Open PR #90 fixes that as separate host-contract work.
- The owner asked for an admin merge, which overrides the skill's default of leaving the PR unmerged.
