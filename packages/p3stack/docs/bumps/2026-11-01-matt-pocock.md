# Matt Pocock bump on 2026-11-01

## Pins

- Source: `matt-pocock`, upstream `mattpocock/skills`.
- Independent checkout: `vendor/matt-pocock`.
- Old SHA: `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa`.
- New SHA: `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`.
- [Upstream comparison](https://github.com/mattpocock/skills/compare/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa...4ae2317ddb22b046e26455e4f9c9b3aaaf62212d).
- [Maintenance PR, by branch](https://github.com/daniel-ballance/pi-packages/pulls?q=is%3Apr+head%3Achore%2Fp3stack-pocock-tip-6e30179d). The returned PR URL is also recorded in the external receipts.

## Upstream scope

- `5ae4816` changes `chief-of-staff` to reuse a shared wiki and invoke retro and specification procedures. Its existing drop verdict still applies.
- `4ae2317` adds the in-progress `software-factory` glossary and design reference.
- Read both complete commits and every changed file in the [upstream diff](file:///tmp/p3stack-maint-6e30179d/pocock-upstream.diff) and [commit statistics](file:///tmp/p3stack-maint-6e30179d/pocock-upstream-commits.txt).
- Both new changesets describe those skills. The in-progress README adds its catalog entry. No package dependency or stable engineering or productivity skill changed.
- Reviewed all six software-factory files: `SKILL.md`, `EXAMPLE-TASKS.md`, `GIT-HOSTS.md`, `OBSERVABILITY-PLATFORMS.md`, `RUNNERS.md`, and `TICKET-TRACKERS.md`. They describe remote factory design, services, and example tasks.

## Decisions

- Add the explicit registry verdict `skills/in-progress/software-factory/SKILL.md`: **drop**. The in-progress remote-factory reference lies outside the supported engineering and productivity maps. Keep the existing bounded workflows.
- All five companion resources remain excluded with their parent skill. Keep the existing `chief-of-staff` drop verdict.
- Update the registry test to expect 25 drops and assert this exact source-relative path has the drop verdict. The 87 emitted skills remain unchanged.
- The first bump exited 1 on the unclassified path. Stage the moved gitlink immediately, classify the path, and regenerate. [Initial failure](file:///tmp/p3stack-maint-6e30179d/pocock-bump.log) and [successful repair](file:///tmp/p3stack-maint-6e30179d/pocock-registry-repair.log) are preserved.
- No token, section hash, patch, route, chain, or lint deny token changed.

## Generated changes

Only the README source pin changes. Generated skills and agents have no semantic or byte delta.
[Second-generation identity](file:///tmp/p3stack-maint-6e30179d/pocock-regeneration-identity.log) confirms the empty intended skill diff.

## Verification

- Audited base: `791b436c861b46fb8c2d2713f3cb5f064bd2f668`. [Current-pin root gate](file:///tmp/p3stack-maint-6e30179d/audit-root.log) passed with `Root check passed.`.
- [Package check](file:///tmp/p3stack-maint-6e30179d/pocock-package-check.log) passed with zero errors. The 105 orphan-resource warnings are expected upstream naming-convention links.
- [Package tests](file:///tmp/p3stack-maint-6e30179d/pocock-tests.log), [generation check](file:///tmp/p3stack-maint-6e30179d/pocock-generated.log), [registry coverage](file:///tmp/p3stack-maint-6e30179d/pocock-registry.log), [static T3 contract](file:///tmp/p3stack-maint-6e30179d/pocock-static-t3.log), and [host lint](file:///tmp/p3stack-maint-6e30179d/pocock-host-lint.log) passed.
- [Live T3 doctor](file:///tmp/p3stack-maint-6e30179d/pocock-doctor.log), [local loader](file:///tmp/p3stack-maint-6e30179d/pocock-loader.log), and [fresh-process smoke](file:///tmp/p3stack-maint-6e30179d/pocock-smoke-verify.log) passed on installed Pi 1.4.0 with `openai-codex/gpt-6.1-sol:xhigh`. The bridge prompt section survived. No model substitution was needed.
- [Live catalog](file:///tmp/p3stack-maint-6e30179d/live-catalog.json) and [host review](file:///tmp/p3stack-maint-6e30179d/host-review.md) record the capability and behavior review. Repository tests use the declared Pi 1.3.0 SDK.
- Final root gate: [complete stream](file:///tmp/p3stack-maint-6e30179d/pocock-root.log). Push hook: [complete stream](file:///tmp/p3stack-maint-6e30179d/pocock-push.log). Command and exit-code files sit beside each stream.
- Routing eval skipped because routes and chains did not change. No validation was bypassed.

Registry result: `87 emitted, 25 dropped, 0 unclassified`. All four authored p3stack rows still emit.

## Follow-up

No dependency refresh or host-contract prerequisite was needed. The independent Cursor update starts at the same audited base, not this branch. This PR remains unmerged.
