# owner-plugins bump on 2026-10-30

## Pins

- Source: `owner-plugins`, upstream `cursor/plugins`.
- Checkout: `vendor/pstack`, shared by `cursor-plugins` and `owner-plugins`.
- Old: `1ba91fc25c0977741dd0e267849e6234b037ed0a`.
- New: `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/1ba91fc25c0977741dd0e267849e6234b037ed0a...4dd1d05818d19792e7cd6e818f1667f95f7e1dbe).
- [Shared maintenance PR #89](https://github.com/daniel-ballance/pi-packages/pull/89).

## Upstream scope

Upstream commit `87fe307c7fd9fbabc695c419a9278ecd04a6c7b7` replaces `third_party/gopuff/assets/logo.png`. Merge commit `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe` brings that change to main. The binary asset grows from 6,720 to 119,773 bytes. It is outside the admitted sources and remains excluded. The full upstream diff has no other change.

The `pstack/`, `dyl-stack/`, and `thermos/` source diffs are empty. There are no packaging changes or unresolved scope decisions.

## Decisions

No skills were added, renamed, removed, or changed in behavior. Registry verdicts, routes, chains, token rules, section hashes, overlays, and patches stay unchanged. Every deny token in `rules/lint.json` is preserved.

## Generated changes

The shared pin updates the package metadata, README provenance for both sources, and seven upstream guide links in `poteto-help`. No agent or skill behavior changes. The two generations have identical diffs. The comparison receipt is `/tmp/p3stack-maint-8a2c6883/cursor/generation-identical.log`.

## Verification

Complete streams and exit codes are outside the checkout at `/tmp/p3stack-maint-8a2c6883/`.

- Current-pins audit: `baseline-root.log` ends with `Root check passed.`. Generation, registry, static host checks, live doctor, loader, and smoke passed at audited main commit `fccaf18c5f0aaee9147f727a80bf167471839e36`.
- Candidate package checks and tests passed. See `cursor/package-check.log` and `cursor/package-tests.log`. Skill lint reports zero errors and 105 existing resource warnings.
- Registry passed with `87 emitted, 24 dropped, 0 unclassified`. All four authored p3stack rows are covered. See `authored-registry.json` and `cursor/registry.log`.
- Static host contract, host lint, live capability doctor, and local-package loader passed. See `cursor/static.log`, `cursor/hosts.log`, `cursor/doctor-verified.log`, and `cursor/loader.log`. The live delegation probe and result retrieval passed in `live-delegation-status.json`.
- The root gate passed with the exact final marker. See `cursor/root.log`.
- The installed Pi 1.4.0 smoke used `openai-codex/gpt-6.1-sol` with explicit `xhigh` thinking and disposable settings. The first reply added a period and failed the exact-reply assertion. Its stream is retained in `cursor/first-smoke.jsonl`. The retry passed with exactly `p3stack smoke ok`, exit zero, and no loader diagnostics. See `cursor/smoke.jsonl` and `cursor/smoke-verified.log`.
- Routing eval is skipped because routes and chains did not change.

## Follow-up

The branch starts at the audited main commit. No portability or dependency prerequisite is needed. No lockfiles or installed hosts change. Matt Pocock is independently verified at its unchanged upstream tip and has no PR or bump note. The shared maintenance PR remains unmerged.
