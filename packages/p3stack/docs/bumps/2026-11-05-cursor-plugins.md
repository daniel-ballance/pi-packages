# Cursor source bump on 2026-11-05

## Pins

- Upstream: `cursor/plugins`.
- Shared checkout: `vendor/pstack`, used by `cursor-plugins` and `owner-plugins`.
- Old SHA: `ae5650febf4320793844c12c4adaa937f417f8da`.
- Candidate SHA: `bb68f2365eceafa0cb2d253112f675acf5f144cc`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/ae5650febf4320793844c12c4adaa937f417f8da...bb68f2365eceafa0cb2d253112f675acf5f144cc).
- [Maintenance PR #94](https://github.com/daniel-ballance/pi-packages/pull/94), shared by both sources.

## Upstream scope

No commits change `pstack/`. All nine changed paths are in the third-party Tailscale and X plugins. The full upstream diff, packaging, and commit stats are in `/tmp/p3stack-maint-167670da/cursor/upstream-scope.log`.

The reviewed commits are `bb68f23`, `e4ebf39`, `180939f`, `2d78679`, `fd268b8`, `e3ae9f9`, `d31c571`, `6ea7458`, `4cdb7b0`, `e32b6a2`, `e9ad1b7`, `e5a88cb`, `b7716e9`, and `8e0a88e`. Tailscale changes its connection guidance and metadata. X changes its posting approval, scopes, error handling, and guide. Neither plugin is mapped into p3stack.

## Decisions

No maintained skill is new, renamed, removed, or behavior-changing. Keep the third-party plugins outside the manifest. No new registry verdict, token match, section hash, patch, route, or chain needs repair. Every deny token is preserved.

## Generated changes

Generation records the two shared pins in the README and the Cursor pin in package metadata. Seven guide URLs in `poteto-help` use the new commit. Skills and agents have no behavior change.

## Verification

Receipts are outside the checkout at `/tmp/p3stack-maint-167670da`. The audit base is `31e6b1fcb6aae4fe207996314a328c501defd239`. Both independent checkout branches start there.

- Current-pin root gate passed with `Root check passed.` in `baseline-root.log`.
- Candidate package check, tests, registry, static T3 contract, and host lint passed. See `cursor/{check,test,registry,t3-static,host-lint}.log`. The registry reports `87 emitted, 25 dropped, 0 unclassified`. The authored registry has four emitted rows.
- The repeated generation has an identical diff. See `cursor/regenerate-repeat.log` and both `cursor/generated-*.diff` snapshots.
- Installed Pi 1.5.0 lists the local package, passes the live T3 doctor, and returns exactly `p3stack smoke ok`. The model is `openai-codex/gpt-6.1-sol:xhigh`. See `cursor/loader-smoke.log`, the individual loader, doctor, and smoke streams, and `host-behavior.md`.
- Candidate root gate passed with `Root check passed.` in `cursor/root.log`.
- Routing eval is skipped because routes and chains did not change. Optional real-TLC test cases are skipped when `TLA2TOOLS` is not configured. No tools were installed to run them.
- Scope review and comment review found no required repairs. See `cursor/decisions.md`, `cursor/upstream-scope.log`, and `comment-review.md`. Expected skill-resource orphan warnings are not errors.

## Follow-up

No dependency refresh or host-contract prerequisite is required. Vendor files, deny tokens, dependencies, lockfiles, and the installed host remain unchanged apart from the shared gitlink. The PR remains unmerged. The older open PR #93 is untouched.
