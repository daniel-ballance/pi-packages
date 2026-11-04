# owner-plugins bump on 2026-11-04

## Pins

- Upstream [cursor/plugins](https://github.com/cursor/plugins).
- Shared checkout `vendor/pstack` serves `cursor-plugins` and `owner-plugins`.
- Old pin: `ae5650febf4320793844c12c4adaa937f417f8da`.
- New pin: `180939f9e59cc9512e9330649175763e81fad16f`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/ae5650febf4320793844c12c4adaa937f417f8da...180939f9e59cc9512e9330649175763e81fad16f).
- Maintenance PR: URL recorded after creation.

## Upstream scope

No path under `dyl-stack/` or `thermos/` changed. The [Cursor source note](2026-11-04-cursor-plugins.md) lists the 12 checkout commits and the eight changed third-party paths. [Mapped-scope diffs and commit stats](file:///tmp/p3stack-maint-8a7a4cbf/cursor-scope.stdout) confirm the owner roots have no delta. The owner bump ran at the same explicit candidate SHA after the Cursor bump.

## Decisions

Retain the existing owner skill decisions. No new, renamed, removed, or behavior-changing skill occurs in either owner root. Third-party X and Tailscale plugins remain outside the manifest. No rules, registry rows, routes, chains, or deny tokens changed.

## Generated changes

Only the shared gitlink and owner README provenance change. No owner skill or agent changes. The shared generation also updates the Cursor guide URL SHAs, as documented in its note. [Second-generation comparison](file:///tmp/p3stack-maint-8a7a4cbf/cursor-generation-identical.stdout) exited 0 with an empty diff.

## Verification

All commands run from the repository root with frozen npm dependencies. Each receipt has matching `.command`, `.stdout`, `.stderr`, and `.exit` files under `/tmp/p3stack-maint-8a7a4cbf`.

- [Current-pins root gate](file:///tmp/p3stack-maint-8a7a4cbf/audit-root.stdout) exited 0 with `Root check passed.`.
- [Generation check](file:///tmp/p3stack-maint-8a7a4cbf/cursor-pin-check.stdout), [registry coverage](file:///tmp/p3stack-maint-8a7a4cbf/cursor-registry.stdout), [package check](file:///tmp/p3stack-maint-8a7a4cbf/cursor-package-check.stdout), and [tests](file:///tmp/p3stack-maint-8a7a4cbf/cursor-package-tests.stdout) exited 0. Coverage remains 87 emitted, 25 dropped, 0 unclassified. The four authored rows also pass the [canonical registry](file:///tmp/p3stack-maint-8a7a4cbf/audit-authored-registry-v2.stdout).
- [Static T3 contract](file:///tmp/p3stack-maint-8a7a4cbf/cursor-static.stdout), [host lint](file:///tmp/p3stack-maint-8a7a4cbf/cursor-host-lint.stdout), and the [live doctor](file:///tmp/p3stack-maint-8a7a4cbf/cursor-doctor.stdout) exited 0. [Live host review](file:///tmp/p3stack-maint-8a7a4cbf/live-host-review.md) records catalog and prompt behavior checks.
- [Local loader](file:///tmp/p3stack-maint-8a7a4cbf/cursor-loader.stdout) lists this worktree's p3stack package. The [fresh-process smoke](file:///tmp/p3stack-maint-8a7a4cbf/cursor-smoke-v2.stdout) and [assertions](file:///tmp/p3stack-maint-8a7a4cbf/cursor-smoke-verify-v2.stdout) passed with `openai-codex/gpt-6.1-sol:xhigh` on installed Pi 1.5.0. No model substitution, resource errors, extension failures, or skill collisions.
- [Candidate root gate](file:///tmp/p3stack-maint-8a7a4cbf/cursor-root.stdout) exited 0 with `Root check passed.`. The committed pre-push hook must pass again on every push.
- Routing eval skipped because routes and chains did not change.

The first candidate smoke returned a final period and failed its exact-reply assertion. The failed streams remain in `cursor-smoke.*` and `cursor-smoke-verify.*`. A fresh process with an unambiguous punctuation instruction passed. The first ad hoc authored audit assumed all inputs were plain Markdown. Its failure remains in `audit-authored-registry.*`; the canonical registry audit above handles the router template.

## Follow-up

This source shares the Cursor maintenance PR and audited main base. No portability or dependency work was required. The PR remains unmerged.
