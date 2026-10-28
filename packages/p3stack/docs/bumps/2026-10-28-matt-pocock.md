# Matt Pocock bump on 2026-10-28

## Pins

- Source: `matt-pocock`, upstream `mattpocock/skills`.
- Independent checkout: `vendor/matt-pocock`.
- Old: `5beb35b040e3de97e54fa9e386d7e42d15c295c2`.
- Candidate: `59db609eb1e18aaf59b63284d0e52255aff0c63c`, checked against upstream main.
- [Upstream comparison](https://github.com/mattpocock/skills/compare/5beb35b040e3de97e54fa9e386d7e42d15c295c2...59db609eb1e18aaf59b63284d0e52255aff0c63c).
- Maintenance PR: awaiting the forge-returned URL.
- Audited base: `696abf9ac018423823edbc32354fa0cf5df680fb`. No portability prerequisite was needed.

## Upstream scope

Two commits:

- `ed0de59`: reachable repository setup, legacy glossary migration, and tracker recipe corrections.
- `59db609`: issue intake and target-repository safeguards.

The three emitted paths are `skills/engineering/setup-matt-pocock-skills/SKILL.md`, `issue-tracker-github.md`, and `issue-tracker-gitlab.md` in that same directory. Two changesets, three issue templates, `CONTRIBUTING.md`, and `docs/engineering/domain-modeling.md` remain outside the manifest maps. Those files describe release notes, upstream contribution policy, and user documentation. They introduce no additional runtime resource or skill. Full commit statistics, scope paths, and diff are in the receipts below.

## Decisions

No new, renamed, or removed skill needs a registry row. Coverage remains `87 emitted, 24 dropped, 0 unclassified`, including all four authored p3stack rows.

Add `pocock-legacy-glossary-migration`, scoped to this source and setup skill, with `min: 1`. Its exact sentence match translates the newly added legacy-filename prose into instructions to inspect the legacy domain glossary and map, offer `git mv` to their `GLOSSARY` names, and update the domain pointers. This retains migration without emitting names denied by the coupling lint. No existing match minimum, deny token, section hash, route, or chain changed. Regression assertions cover the migration, reachable repository requirement, target-repository guard, and corrected GitLab JSON flag.

## Generated changes

- Setup inspects legacy glossary files and pointers, offers their migration, and requires a reachable GitHub or GitLab repository before it writes tracker configuration.
- The GitHub recipe uses native dependency commands, counts open blockers, comments before closing, checks the issue target, and reads PR bodies separately from comments.
- The GitLab recipe corrects the JSON flag and traverses linked child issues for frontier selection.
- README source metadata records the candidate. No other source pin changes.

A second generation produces the same intended diff. See [first diff](/tmp/p3stack-maint-c51dbfca/pocock-generated-first.diff), [second diff](/tmp/p3stack-maint-c51dbfca/pocock-generated-second.diff), and [empty comparison](/tmp/p3stack-maint-c51dbfca/pocock-idempotence.log).

## Verification

Complete receipts, command lines, and exit codes are in `/tmp/p3stack-maint-c51dbfca/`.

- [Current-pins root gate](/tmp/p3stack-maint-c51dbfca/baseline-root.log): exit 0, `Root check passed.`
- [Baseline generation](/tmp/p3stack-maint-c51dbfca/baseline-generation.log), [registry](/tmp/p3stack-maint-c51dbfca/baseline-registry.log), and [static host contract](/tmp/p3stack-maint-c51dbfca/baseline-t3-static.log): passed.
- [Candidate package check](/tmp/p3stack-maint-c51dbfca/pocock-check.log): exit 0, current generated output, host lint passed, and zero skill errors. Orphan warnings are expected upstream resources.
- [Candidate tests](/tmp/p3stack-maint-c51dbfca/pocock-test.log): exit 0 under both host modes.
- [Candidate registry](/tmp/p3stack-maint-c51dbfca/pocock-registry.log) and [static contract](/tmp/p3stack-maint-c51dbfca/pocock-t3-static.log): passed.
- [Candidate root gate](/tmp/p3stack-maint-c51dbfca/pocock-root.log): exit 0, `Root check passed.`
- [Loader](/tmp/p3stack-maint-c51dbfca/pocock-loader.log), [live doctor](/tmp/p3stack-maint-c51dbfca/pocock-doctor-check.log), [live behavior evidence](/tmp/p3stack-maint-c51dbfca/live-host-evidence.md), and [smoke verification](/tmp/p3stack-maint-c51dbfca/pocock-smoke-verified.log): passed. Disposable settings load this local package with `openai-codex/gpt-6.1-sol:xhigh`; the fresh reply is `p3stack smoke ok`.
- [Independent scope and comment review](/tmp/p3stack-maint-c51dbfca/pocock-review.json): no actionable findings or comment deletions.
- Routing eval skipped because neither routes nor chains changed.

## Follow-up

The shared Cursor checkout needs a separate dependency refresh for its new statechart test dependency. That work is isolated from this PR and documented in [the handoff](/tmp/p3stack-maint-c51dbfca/dependency-refresh-handoff.md). This update changes no dependency lockfile, host release, fingerprint, or live agent setting. Leave the maintenance PR unmerged.
