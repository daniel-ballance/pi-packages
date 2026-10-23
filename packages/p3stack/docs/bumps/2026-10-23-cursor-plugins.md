# cursor-plugins bump on 2026-10-23

## Pins

- Source: `cursor-plugins`, upstream `cursor/plugins`.
- Checkout: `vendor/pstack`, shared with `owner-plugins`. Both sources use one gitlink and one maintenance PR.
- Old: `88d47514b82e7c44f00f2b2a72ff6dd12158038c`, pstack 0.15.29.
- New: `8b3326d99fd4b993cb33a24dad8af03175c642c5`, pstack 0.15.30.
- [Upstream comparison](https://github.com/cursor/plugins/compare/88d47514b82e7c44f00f2b2a72ff6dd12158038c...8b3326d99fd4b993cb33a24dad8af03175c642c5).
- Maintenance PR: pending parent creation. Depends on [unmerged prerequisite #75](https://github.com/daniel-ballance/pi-packages/pull/75), with base `chore/p3stack-portability-602346f4`.

## Upstream scope

The pstack commits are `eb4db2b`, which adds statechart, `7698375`, which corrects model checks and output handling, and `4ec7ffa`, which removes redundant comments and renames helpers. Review covers all commits and their stats, not only these three.

Mapped changes add `skills/statechart/SKILL.md` and its scripts, model, tests, and fixtures. The existing `skills/poteto-help/SKILL.md` gains a statechart link. Review also covers both plugin manifests, the upstream README, and guide page 6. The manifests change the version to 0.15.30. The README and guide explain the new skill; they remain external documentation.

Packaging outside `pstack/`, third-party integrations, intermediate changes and reverts, and generated Claude harness copies remain outside the Pi maps. The owner subtrees have no content delta. Full command streams, all commit diffs, and path decisions are in [upstream-review.log](/tmp/p3stack-maint-602346f4/cursor/upstream-review.log), [outside-scope-review.md](/tmp/p3stack-maint-602346f4/cursor/outside-scope-review.md), and [decisions.md](/tmp/p3stack-maint-602346f4/cursor/decisions.md).

## Decisions

- Emit the exact new path `cursor-plugins/skills/statechart/SKILL.md` as user-invoked `statechart`. Its Node scripts draw user-visible behavior and model counterexamples without a Cursor backend. TLC and PNG rendering remain explicit external prerequisites.
- Emit runtime scripts and model resources unchanged. Exclude `skills/statechart/scripts/test/` through the manifest, because packages must not ship development test directories. Run the unmodified suite from vendor and assert byte identity for every emitted runtime resource. [statechart-review.md](/tmp/p3stack-maint-602346f4/cursor/statechart-review.md) covers the full upstream diffs.
- Keep the help row and let the existing slash-command rule translate `/statechart` to `/skill:statechart`.
- Update the Cursor emitted-count assertion from 55 to 56. Add user-invocation, help-link, byte-identity, and test-resource exclusion assertions. Import upstream's test suite into the package tests.
- Add the scoped token rule `statechart-execution-boundaries` with `min: 1`. It expands the upstream scratch-folder sentence into requirements for disposable output trees, absolute tool paths, trusted maps, and approval before renderer downloads. The review reproduces deletion of unknown nested output files and failure with relative tool paths. These upstream code limitations remain; the skill now avoids them through explicit execution boundaries. Tests assert each boundary in the generated text.
- No skill is renamed or removed. Routes and chains stay unchanged. No existing min-match, section-hash, overlay, patch, or deny-lint repair is needed. All existing rule minima and deny tokens stay unchanged. The new token has no previous `find` value; its literal match is in the [decision list](/tmp/p3stack-maint-602346f4/cursor/decisions.md).

## Generated changes

Generation adds the statechart skill and runtime resources, preserves the new help row, updates commit-pinned guide links, and records both shared source pins. Runtime scripts and models are byte-identical to canonical upstream files. Development tests and fixtures stay outside generated output. The skill's scratch-folder paragraph gains the reviewed execution boundaries. No agent or owner skill changes.

Two generations produce identical binary skills-and-agents diffs. See [generation-identical.log](/tmp/p3stack-maint-602346f4/cursor/generation-identical.log) and the [first](/tmp/p3stack-maint-602346f4/cursor/generation-first.diff) and [second](/tmp/p3stack-maint-602346f4/cursor/generation-second.diff) snapshots.

## Verification

Receipts include the exact command, complete stream, and exit code in `.command`, `.log`, and `.exit` siblings.

- Current-pin audit: [root](/tmp/p3stack-maint-602346f4/audit/root.log), [generation](/tmp/p3stack-maint-602346f4/audit/generation.log), [registry](/tmp/p3stack-maint-602346f4/audit/registry.log), [static host](/tmp/p3stack-maint-602346f4/audit/static-host.log), and [loader baseline](/tmp/p3stack-maint-602346f4/audited-loader-retry/PASS.txt) passed before the bump.
- Candidate: [package check](/tmp/p3stack-maint-602346f4/cursor/package-check.log), [package tests](/tmp/p3stack-maint-602346f4/cursor/package-tests.log), [registry](/tmp/p3stack-maint-602346f4/cursor/registry.log), [static host](/tmp/p3stack-maint-602346f4/cursor/static-host.log), [host lint](/tmp/p3stack-maint-602346f4/cursor/lint-hosts.log), and [generator check](/tmp/p3stack-maint-602346f4/cursor/generator-check.log) exit 0. The registry reports `86 emitted, 24 dropped, 0 unclassified`.
- Each package test pass has 207 passing tests and 38 TLC-dependent skips, followed by 70 passing helper tests. No TLC installation is present. Live model checking and PNG rendering are not claimed.
- The first root run found that generated test fixtures violated the existing packaging guard. [round-1/root.log](/tmp/p3stack-maint-602346f4/cursor/round-1/root.log) preserves that failure. The scoped manifest exclusion repairs the package without changing the guard.
- Final [root gate](/tmp/p3stack-maint-602346f4/cursor/root.log) exits 0 with `Root check passed.`. Final [loader and smoke](/tmp/p3stack-maint-602346f4/cursor/final-loader/PASS.txt) verify the local package, exact native and T3 replies, clean stderr, live doctor contract, and bridge prompt integration with `openai-codex/gpt-6.1-sol:xhigh`. [Live catalog evidence](/tmp/p3stack-maint-602346f4/cursor/live-capabilities.json) also records the selected model and delegation capability.
- The first final T3 smoke reply added a period. [final-loader-punctuation-run.log](/tmp/p3stack-maint-602346f4/cursor/final-loader-punctuation-run.log) and its fixture directory preserve that exact-response failure. One retry of the original command and prompt passed every native and T3 assertion; no acceptance condition changed.
- Routing eval skipped because routes, chains, router output, and playbooks are unchanged.

## Follow-up

No dependency refresh or host-contract repair is included. Lockfiles, installed tools, and live agent settings stay unchanged. Upstream output-ownership and relative-tool-path defects remain in the unchanged runtime scripts. The skill requires disposable output and absolute paths instead of claiming code-level fixes. The parent owns push, PR creation, host linkage, and insertion of the returned PR URL. The maintenance PR and prerequisite remain unmerged.
