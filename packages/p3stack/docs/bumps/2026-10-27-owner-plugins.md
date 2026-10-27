# Owner plugins bump on 2026-10-27

## Pins

- Source `owner-plugins` from `cursor/plugins`.
- Shared checkout `vendor/pstack` supplies `cursor-plugins` and `owner-plugins`; both use one candidate and one PR.
- Old pin: `99b609a72323b70204eab407c622f436e858e112`.
- New pin: `ab69380dd50ee47d426b35cb8369cffdddafc218`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/99b609a72323b70204eab407c622f436e858e112...ab69380dd50ee47d426b35cb8369cffdddafc218).
- Maintenance PR: pending creation; its returned URL will replace this line.

## Upstream scope

The checkout advances across 21 commits, including merges. The [commit list](/tmp/p3stack-maint-6e5c1df5/cursor/upstream-commits.log), [per-commit statistics](/tmp/p3stack-maint-6e5c1df5/cursor/upstream-stats.log), and [full diff](/tmp/p3stack-maint-6e5c1df5/cursor/upstream-full.diff) record the review.

No paths change under `pstack/`, `dyl-stack/`, or `thermos/`. The complete changed-path list is in the [scope receipt](/tmp/p3stack-maint-6e5c1df5/cursor/upstream-paths.log).

- `.cursor-plugin/marketplace.json` and the upstream `README.md` add RingCentral Phone and Chat listings. These catalog files are not p3stack inputs.
- `third_party/ringcentral-chat/` and `third_party/ringcentral-phone/` each add a plugin manifest, changelog, license, README, logo, and MCP configuration. These external service integrations stay outside the declared source roots.
- `third_party/tailscale/` changes its plugin manifest, changelog, README, and setup skill. The skill now describes multiple tailnets, company postures, personal authentication, routing, and troubleshooting. It depends on Grok Bot's connection service and stays outside the declared source roots.

## Decisions

No mapped skills are new, renamed, removed, or behavior-changing. No registry rows, rules, section hashes, patches, routes, or chains need repair. Every deny token in `rules/lint.json` remains unchanged.

The new third-party integrations do not expand p3stack's scope. The registry covers the declared roots and reports `87 emitted, 24 dropped, 0 unclassified`. Its four authored p3stack rows also pass.

## Generated changes

The package README and upstream metadata record the new shared pin. Seven guide URLs in `poteto-help` use that pin. Skill instructions and generated agents do not change. The [second-generation receipt](/tmp/p3stack-maint-6e5c1df5/cursor/regeneration-receipt.log) confirms an identical generated diff.

## Verification

All required final checks pass with exit code 0.

- Audited base `e9ff3d10d5da8a68cb7a779c2c4b0a14aca0c410`: [current-pin root gate](/tmp/p3stack-maint-6e5c1df5/baseline-root.log), [generation](/tmp/p3stack-maint-6e5c1df5/baseline-generation.log), [registry](/tmp/p3stack-maint-6e5c1df5/baseline-registry.log), and [static host](/tmp/p3stack-maint-6e5c1df5/baseline-static-host.log).
- [Final command results](/tmp/p3stack-maint-6e5c1df5/cursor/validation/validation.json): package check, package tests in both host environments, registry coverage, static host contract, host lint, and root gate.
- [Final loader and live host checks](/tmp/p3stack-maint-6e5c1df5/cursor/host-exact.log): local package in `pi list`, capability-based T3 doctor, installed Pi model catalog, supported thinking level, and the exact fresh-process reply `p3stack smoke ok`. No loader errors, missing resources, or skill collisions.
- Session and smoke use `openai-codex/gpt-6.1-sol:xhigh`. Installed Pi 1.4.0 loads the local package. Development checks use the locked repository SDK, not release equality.
- The [first](/tmp/p3stack-maint-6e5c1df5/cursor/host/smoke.jsonl) and [second](/tmp/p3stack-maint-6e5c1df5/cursor/host-retry/smoke.jsonl) smoke replies included a trailing period. Their exact-reply assertions failed. An explicit no-punctuation prompt passed without changing the acceptance check. All streams remain in the receipts.
- Routing eval is skipped because no route or chain changed.

## Follow-up

No dependency refresh or host repair is needed. No lockfiles or installed tools change. Pocock is independently verified at its existing upstream tip and has no PR or bump note. This shared-checkout PR remains unmerged.
