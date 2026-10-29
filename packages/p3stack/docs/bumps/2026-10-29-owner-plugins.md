# owner-plugins bump on 2026-10-29

## Pins

- Source: owner-plugins, upstream cursor/plugins.
- Checkout: vendor/pstack (shared by cursor-plugins and owner-plugins).
- Old: `ab69380dd50ee47d426b35cb8369cffdddafc218`.
- Candidate: `1ba91fc25c0977741dd0e267849e6234b037ed0a`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/ab69380dd50ee47d426b35cb8369cffdddafc218...1ba91fc25c0977741dd0e267849e6234b037ed0a).
- Maintenance PR: [#87](https://github.com/daniel-ballance/pi-packages/pull/87).

## Upstream scope

Statechart becomes a TypeScript compiler with frontends, passes, backends, a shell launcher, and differential tests. Keep its user-only registry verdict and all runtime resources. Run all upstream compiler suites in a disposable fixture, with installed-only rendering and TLC probes. Test the emitted launcher against the recorded corpus.

Orchestrate replaces the orch runtime with owner and verifier instructions. The orchestrate-host-limits rule keeps nesting conditional on host support and caps concurrency at the live-child limit. Remove obsolete orch rules, the roles overlay, and the deleted test glob. Interrogate now reuses Arena and accepts only findings verified by execution. Arena requires a different-family judge or explicitly skips judgment; its runner fallback retains the requested seat count. Autopilot-stack stacks only dependent PRs. Other changes update video, explanation, setup, and PR guidance.

The mapped compiler pass is named cycle-check.ts to retain the /loop deny token; its import changes with it. The shell launcher uses Node. Slash-skill translation is restricted to Markdown so it cannot corrupt executable paths. No deny tokens were removed or narrowed.

Retired rules: interrogate-launch, interrogate-fields, interrogate-rejected, read-grep-glob-rubric, transcripts-orchestrate, orchestrate-store, control-runtime, orchestrate-local-spawns, orchestrate-spawn-budget, orchestrate-rebase, orchestrate-dashboard, orchestrate-restart, orchestrate-bun, bun-shebang, bun-bootstrap-import, bun-bootstrap-call, bun-import-meta-main, bun-test-orch, erasable-parameter-property. The three two-script Bun guards are replaced by explicit watch-pr-only guards because the orch executable was deleted, not by reducing an existing minimum.

No new, renamed, or removed skill needs a registry verdict. Routes and chains are unchanged; routing eval is skipped for that reason. All source scope decisions and full upstream diffs are recorded in the external cursor receipts. Owner subtrees have no content delta, but share the pin. Packaging outside canonical source maps remains excluded.

## Decisions

The owner source shares the Cursor pin. See [Cursor decisions](2026-10-29-cursor-plugins.md) for the complete generator and section review.

## Generated changes

Generated output follows the reviewed decisions above. The second generation must match the staged generated output byte for byte; see `/home/danballance/.local/state/p3stack-maint/2026-10-29-b42a41d6/cursor/determinism-final.json`.

## Verification

Complete command streams and exit codes: `/home/danballance/.local/state/p3stack-maint/2026-10-29-b42a41d6/cursor/`.

- Baseline: original current-pins audit and dependency baseline npm/pnpm root gates passed.
- Candidate: package checks/tests, static host checks, registry, final root gate, and local Pi loader/smoke passed. Results are in `root-resume.json`, `static-resume.json`, and `smoke-resume.json`.
- Authored registry: four rows; zero unclassified.
- Live T3 audit: original genuine doctor and bridge smoke are in `audit/`; current Codex catalog is in `live-codex-catalog.json`. This resumed Codex process has no Pi bridge environment; final fresh-process smoke uses native Pi with explicit openai-codex/gpt-6-astra and medium thinking. No installed host or fingerprint changed.
- Optional TLC and renderer tests skip when installed tools are absent. Recorded-corpus compiler and CLI tests still run.
- Routing eval: skipped; no route or chain changes.

## Follow-up

Depends on [dependency prerequisite #85](https://github.com/daniel-ballance/pi-packages/pull/85), verified commit `711e176cc9f176e0a0d1e49dda6a720ea1c99b50`. Source PR contains no dependency-lock changes. All PRs remain unmerged.
