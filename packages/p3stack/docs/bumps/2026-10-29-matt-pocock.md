# matt-pocock bump on 2026-10-29

## Pins

- Source: matt-pocock, upstream mattpocock/skills.
- Checkout: vendor/matt-pocock.
- Old: `59db609eb1e18aaf59b63284d0e52255aff0c63c`.
- Candidate: `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa`.
- [Upstream comparison](https://github.com/mattpocock/skills/compare/59db609eb1e18aaf59b63284d0e52255aff0c63c...a496f5513d4a4cf889bc48e189e579f4b0bdf6aa).
- Maintenance PR: pending creation after validation.

## Upstream scope

Upstream commits a496f55, d1478fc, and 7739eae require fresh context for subagents and a new implementer for each ticket or review-fix task. Seven emitted resources carry that guidance. The existing chief-of-staff drop remains unchanged. Repair subagent-dispatch to preserve the new fresh-context instruction while retaining bounded investigation and the direct-lookup fallback.

Review-scope changes are version 1.3.2 packaging, release changelog, retired release changesets, the new implementer changeset, and the contributor guidance. They remain outside emitted resources. No new skill, route, or chain changed; registry coverage remains complete. Routing eval is skipped for unchanged routes and chains.

## Decisions

## Min-match repair

Rule id
```text
subagent-dispatch
```

Old find
```text
Finding _facts_ is your job, never the user's\. When a frontier question needs a fact from the environment \(filesystem, tools, etc\.\), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself\. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now\. The _decisions_ are the user's: put each to them and wait\.
```

New find
```text
Finding _facts_ is your job, never the user's\. When a frontier question needs a fact from the environment \(filesystem, tools, etc\.\), dispatch a sub-agent with a fresh context window to find it; don't ask the user for anything you could look up yourself\. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now\. The _decisions_ are the user's: put each to them and wait\.
```

Unchanged min
```text
1
```

## Generated changes

Generated output follows the reviewed decisions above. The second generation must match the staged generated output byte for byte; see `/home/danballance/.local/state/p3stack-maint/2026-10-29-b42a41d6/pocock/determinism-final.json`.

## Verification

Complete command streams and exit codes: `/home/danballance/.local/state/p3stack-maint/2026-10-29-b42a41d6/pocock/`.

- Baseline: original current-pins audit and dependency baseline npm/pnpm root gates passed.
- Candidate: package checks/tests, static host checks, registry, final root gate, and local Pi loader/smoke passed. Results are in `root-resume.json`, `static-resume.json`, and `smoke-resume.json`.
- Authored registry: four rows; zero unclassified.
- Live T3 audit: original genuine doctor and bridge smoke are in `audit/`; current Codex catalog is in `live-codex-catalog.json`. This resumed Codex process has no Pi bridge environment; final fresh-process smoke uses native Pi with explicit openai-codex/gpt-6-astra and medium thinking. No installed host or fingerprint changed.
- Optional TLC and renderer tests skip when installed tools are absent. Recorded-corpus compiler and CLI tests still run.
- Routing eval: skipped; no route or chain changes.

## Follow-up

Depends on [dependency prerequisite #85](https://github.com/daniel-ballance/pi-packages/pull/85), verified commit `711e176cc9f176e0a0d1e49dda6a720ea1c99b50`. Source PR contains no dependency-lock changes. All PRs remain unmerged.
