# cursor-plugins bump on 2026-11-04

## Pins

- Upstream [cursor/plugins](https://github.com/cursor/plugins).
- Shared checkout `vendor/pstack` serves `cursor-plugins` and `owner-plugins`.
- Old pin: `ae5650febf4320793844c12c4adaa937f417f8da`.
- New pin: `180939f9e59cc9512e9330649175763e81fad16f`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/ae5650febf4320793844c12c4adaa937f417f8da...180939f9e59cc9512e9330649175763e81fad16f).
- Maintenance PR: URL recorded after creation.

## Upstream scope

The full checkout delta contains 12 commits:

- `180939f`, `2d78679`: Tailscale plugin 1.0.6 and one-click tailnet description.
- `fd268b8`, `e3ae9f9`, `d31c571`: X posting guide, edit parameters, approval, and PIN handling.
- `6ea7458`, `4cdb7b0`: Tailscale plugin 1.0.5 removes tagged sign-in and documents the bot computer.
- `e32b6a2`, `e9ad1b7`, `e5a88cb`, `b7716e9`, `8e0a88e`: X plugin 2.11.0, posting approvals, error handling, and shorter guidance.

No changed path is under `pstack/`, `dyl-stack/`, or `thermos/`. The full diff changes eight paths outside all registered roots:

- `third_party/tailscale/.cursor-plugin/plugin.json`, `CHANGELOG.md`, and `skills/tailscale-setup/SKILL.md` under that plugin.
- `third_party/x/.cursor-plugin/plugin.json`, `CHANGELOG.md`, `README.md`, `mcp.json`, and `skills/x-api-mcp-guide/SKILL.md` under that plugin.

[Full diff](file:///tmp/p3stack-maint-8a7a4cbf/cursor-upstream-review.stdout) and [per-commit stats and mapped-scope diffs](file:///tmp/p3stack-maint-8a7a4cbf/cursor-scope.stdout) retain the review. The bump report contains no review-scope path.

## Decisions

Keep the third-party plugins outside the manifest. Their Grok Bot Tailscale and hosted X connector behavior is outside the registered engineering sources. No new, renamed, removed, or behavior-changing skill occurs in the registered roots. No classification, token, minimum-match, section-hash, patch, route, or chain change is needed. Every coupling-lint deny token remains unchanged.

## Generated changes

The gitlink, package upstream metadata, and README pins move together. Generation updates seven guide URL SHAs in `poteto-help`. It changes no workflow behavior. [Two-generation comparison](file:///tmp/p3stack-maint-8a7a4cbf/cursor-generation-identical.stdout) exited 0 with an empty diff.

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

The audited base is `31e6b1fcb6aae4fe207996314a328c501defd239`. No portability prerequisite or dependency refresh was needed. Lockfiles and the installed host remain unchanged. The separate Pocock checkout already matches its fetched upstream tip and receives no note or PR. The maintenance PR remains unmerged.
