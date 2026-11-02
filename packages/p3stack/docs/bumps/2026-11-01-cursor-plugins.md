# Cursor plugins bump on 2026-11-01

## Pins

- Source: `cursor-plugins`, upstream `cursor/plugins`.
- Shared checkout: `vendor/pstack`, owned by `cursor-plugins` and `owner-plugins`. Both use one candidate and one PR.
- Old SHA: `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`.
- New SHA: `ae5650febf4320793844c12c4adaa937f417f8da`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe...ae5650febf4320793844c12c4adaa937f417f8da).
- [Shared maintenance PR, by branch](https://github.com/daniel-ballance/pi-packages/pulls?q=is%3Apr+head%3Achore%2Fp3stack-cursor-tip-6e30179d). The returned PR URL is also recorded in the external receipts.

## Upstream scope

- `111ee2e` adds the Lark Base REST MCP plugin. `ae5650f` merges upstream PR #1150.
- Reviewed every path in the [full upstream diff](file:///tmp/p3stack-maint-6e30179d/cursor-upstream.diff) and the [commit statistics](file:///tmp/p3stack-maint-6e30179d/cursor-upstream-commits.txt).
- The delta contains the marketplace entry, the root README entry, all five Lark Base text/configuration files, its logo, and the Lark README cross-link. These third-party integration files are outside the three admitted source trees.
- Neither `pstack/` nor `dyl-stack/` nor `thermos/` changed. Their separate [Cursor](file:///tmp/p3stack-maint-6e30179d/cursor-source-delta.txt) and [owner](file:///tmp/p3stack-maint-6e30179d/owner-source-delta.txt) diffs are empty.

## Decisions

- No new, renamed, removed, or behavior-changing skill occurs in the admitted source scopes. Keep the Lark Base integration outside p3stack's maps.
- Run both shared-source bump commands at the same candidate. Keep the shared gitlink in this PR.
- No registry verdict, token rule, section hash, patch, route, or chain changed. Every lint deny token remains intact.

## Generated changes

- Refresh the two shared-source README pins and package provenance.
- The only skill delta updates seven upstream guide URLs in `poteto-help` to the candidate commit. Skill behavior and agents are unchanged.
- [Second-generation identity](file:///tmp/p3stack-maint-6e30179d/cursor-regeneration-identity.log) confirms an identical intended diff. [Generated diff](file:///tmp/p3stack-maint-6e30179d/cursor-generated-second.diff).

## Verification

- Audited base: `791b436c861b46fb8c2d2713f3cb5f064bd2f668`. [Current-pin root gate](file:///tmp/p3stack-maint-6e30179d/audit-root.log) passed with `Root check passed.`.
- [Package check](file:///tmp/p3stack-maint-6e30179d/cursor-package-check.log) passed with zero errors. The 105 orphan-resource warnings are expected upstream naming-convention links.
- [Package tests](file:///tmp/p3stack-maint-6e30179d/cursor-tests.log), [generation check](file:///tmp/p3stack-maint-6e30179d/cursor-generated.log), [registry coverage](file:///tmp/p3stack-maint-6e30179d/cursor-registry.log), [static T3 contract](file:///tmp/p3stack-maint-6e30179d/cursor-static-t3.log), and [host lint](file:///tmp/p3stack-maint-6e30179d/cursor-host-lint.log) passed.
- [Live T3 doctor](file:///tmp/p3stack-maint-6e30179d/cursor-doctor.log), [local loader](file:///tmp/p3stack-maint-6e30179d/cursor-loader.log), and [fresh-process smoke](file:///tmp/p3stack-maint-6e30179d/cursor-smoke-verify.log) passed on installed Pi 1.4.0 with `openai-codex/gpt-6.1-sol:xhigh`. The bridge prompt section survived. No model substitution was needed.
- [Live catalog](file:///tmp/p3stack-maint-6e30179d/live-catalog.json) and [host review](file:///tmp/p3stack-maint-6e30179d/host-review.md) record the capability and behavior review. Repository tests use the declared Pi 1.3.0 SDK.
- Final root gate: [complete stream](file:///tmp/p3stack-maint-6e30179d/cursor-root.log). Push hook: [complete stream](file:///tmp/p3stack-maint-6e30179d/cursor-push.log). Command and exit-code files sit beside each stream.
- Routing eval skipped because routes and chains did not change. No validation was bypassed.

## Follow-up

No dependency refresh or host-contract prerequisite was needed. The independent Matt Pocock update starts at the same audited base, not this branch. This PR remains unmerged.
