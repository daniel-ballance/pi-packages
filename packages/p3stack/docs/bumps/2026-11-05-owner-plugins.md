# Owner source bump on 2026-11-05

## Pins

- Upstream: `cursor/plugins`.
- Shared checkout: `vendor/pstack`, used by `cursor-plugins` and `owner-plugins`.
- Old SHA: `ae5650febf4320793844c12c4adaa937f417f8da`.
- Candidate SHA: `bb68f2365eceafa0cb2d253112f675acf5f144cc`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/ae5650febf4320793844c12c4adaa937f417f8da...bb68f2365eceafa0cb2d253112f675acf5f144cc).
- Maintenance PR: pending creation after validation.

## Upstream scope

No commits change `dyl-stack/` or `thermos/`. The shared checkout's nine changed paths are third-party Tailscale and X files outside this source. The [Cursor note](2026-11-05-cursor-plugins.md) lists the reviewed commits. The complete diff and packaging review are in `/tmp/p3stack-maint-167670da/cursor/upstream-scope.log`.

## Decisions

No owner skill is new, renamed, removed, or behavior-changing. Keep the existing source maps and registry verdicts. No rule, section, route, chain, or test repair is required. Every deny token is preserved.

## Generated changes

The README records the owner source's new shared pin. Owner skills and agents are byte-identical. The shared PR also includes Cursor metadata and seven generated guide URLs, as recorded in the Cursor note.

## Verification

Receipts are outside the checkout at `/tmp/p3stack-maint-167670da`. The audit base is `31e6b1fcb6aae4fe207996314a328c501defd239`. Both independent checkout branches start there.

- Current-pin root gate passed with `Root check passed.` in `baseline-root.log`.
- Candidate package check, tests, registry, static T3 contract, and host lint passed. See `cursor/{check,test,registry,t3-static,host-lint}.log`. The registry reports `87 emitted, 25 dropped, 0 unclassified`. The authored registry has four emitted rows.
- The repeated generation has an identical diff. See `cursor/regenerate-repeat.log` and both `cursor/generated-*.diff` snapshots.
- Installed Pi 1.5.0 lists the local package, passes the live T3 doctor, and returns exactly `p3stack smoke ok`. The model is `openai-codex/gpt-6.1-sol:xhigh`. See `cursor/loader-smoke.log`, the individual loader, doctor, and smoke streams, and `host-behavior.md`.
- Candidate root gate passed with `Root check passed.` in `cursor/root.log`.
- Routing eval is skipped because routes and chains did not change.
- Scope review and comment review found no required repairs. See `cursor/decisions.md`, `cursor/upstream-scope.log`, and `comment-review.md`. Expected skill-resource orphan warnings are not errors.

## Follow-up

No dependency refresh or host-contract prerequisite is required. Vendor files, deny tokens, dependencies, lockfiles, and the installed host remain unchanged apart from the shared gitlink. The PR remains unmerged. The older open PR #93 is untouched.
