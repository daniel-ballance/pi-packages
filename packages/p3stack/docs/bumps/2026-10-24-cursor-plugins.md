# cursor-plugins bump on 2026-10-24

## Pins

- Source: `cursor-plugins`, upstream `cursor/plugins`.
- Checkout: `vendor/pstack`, shared with `owner-plugins`. Both sources use one gitlink and [maintenance PR #76](https://github.com/daniel-ballance/pi-packages/pull/76).
- Audited original pin: `88d47514b82e7c44f00f2b2a72ff6dd12158038c`.
- Previous PR candidate: `8b3326d99fd4b993cb33a24dad8af03175c642c5`.
- New upstream tip: `9580c23696ac8d7abed0c166f2f9918800afb819`, pstack 0.15.32.
- [Upstream comparison](https://github.com/cursor/plugins/compare/88d47514b82e7c44f00f2b2a72ff6dd12158038c...9580c23696ac8d7abed0c166f2f9918800afb819).
- Audited base: portability commit `04a2cc918836bb822ecb2836f61d56ce07584285`, separate [PR #75](https://github.com/daniel-ballance/pi-packages/pull/75). That PR passed independent execution verification and merged as `2b5b44dc49765f628f173e0f2252c24a4ce7249f`. The source PR moves onto that merged base before landing.

## Upstream scope

The [previous note](2026-10-23-cursor-plugins.md) covers the first statechart candidate. This continuation reviews all 23 additional commit records and stats. The pstack commits update statechart and its renderer, add ketchup-video, refer formal verification to statechart, repair reflect destinations, distinguish fork heads, cap polling sleeps, recognize multi-backtick code spans, prefer active PRs, support GNU stat/date, and renumber swarm steps. Full scope decisions and commit records are in the [independent review](/tmp/p3stack-maint-46919880/cursor/review/decision-scope.md).

Both plugin manifests, the upstream README, and guide page 10 are reviewed. They update pstack metadata and describe ketchup-video or Claude marketplace updates. Marketplace listings, third-party plugins, and generated Claude copies remain outside the Pi maps. The review accounts for Power BI, PitchBook, QuickBooks, and the Databricks change and revert. Owner subtrees remain unchanged.

## Decisions

- Emit `cursor-plugins/skills/statechart/SKILL.md`, introduced by the previous candidate, and `cursor-plugins/skills/ketchup-video/SKILL.md`. Both are user-invoked. Ketchup-video keeps the text fallback when video rendering fails. Neither adds a route or chain.
- Keep all 21 statechart runtime modules byte-identical to canonical upstream. Exclude development fixtures through the existing manifest rule. Accept upstream's generalized system labels, cover mode, property traces, safer snapshot/publication handling, Pele/resvg renderer, and removed OutputFolder model. Do not claim that the removed model proof still runs.
- Update `statechart-execution-boundaries` for absolute Java paths and pinned Pele/resvg downloads. Add `statechart-provisioning-approval`. Require permission before provisioning and existing absolute tool paths for no-install model checks. Missing TLC or rendering remains explicit, not a model-check pass.
- Add `reflect-installed-skill-destination` to preserve the installed-package guard in Pi terms. Generated skills change through authored inputs and regeneration, not installed package edits.
- Repair `swarm-fan-out` from the escaped `step\\ 4\\ model` match to `step\\ 3\\ model`. Its replacement also names step 3. Keep `min: 1`. The exact literal old and new `find` values are in [swarm-min-match.json](/tmp/p3stack-maint-46919880/cursor/swarm-min-match.json) and the PR body.
- Rebase `0001-worktree-audit-reads-pi-sessions.patch` onto upstream's GNU/BSD `stat_fmt` and `fmt_day` helpers. Keep Pi session discovery and literal path matching.
- Add strict `toBeUndefined` support to the authored Bun-to-Node shim and test its positive and negative cases.
- Preserve every deny token, all existing rule minima, routes, chains, and lockfiles. No section hash changes.

## Generated changes

Generation adds ketchup-video and its help link, updates formal-verification, reflect, swarm, helper scripts, statechart, commit-pinned guide links, and both shared source pins. Each behavior maps to a decision above or the unchanged upstream helper fixes described in the scope review. No owner skill or agent behavior changes.

Two generations have identical skills-and-agents diffs. See [generation-identical](/tmp/p3stack-maint-46919880/cursor/generation-identical.exit). A later patch-context-only edit produces the same output, verified by [patch-context-identical](/tmp/p3stack-maint-46919880/cursor/patch-context-identical.exit).

## Verification

All receipts are outside the checkout under `/tmp/p3stack-maint-46919880/`. Each command has `.command`, `.stdout`, `.stderr`, and `.exit` siblings.

- Current-pins root gate passed at [portability/root](/tmp/p3stack-maint-46919880/portability/root.stdout). [Baseline checks](/tmp/p3stack-maint-46919880/baseline/) and [loader](/tmp/p3stack-maint-46919880/baseline-loader/PASS.txt) passed before moving pins. Main's earlier installed-version/hash-only failure is preserved in `audit-main/root.*`; it was repaired separately, without changing the fingerprints or hosts.
- Candidate package check, tests, registry, static host contract, host lint, generator check, and [root gate](/tmp/p3stack-maint-46919880/cursor/root.stdout) passed. The root ended with `Root check passed.`. The registry reports `87 emitted, 24 dropped, 0 unclassified`, including all four authored rows.
- Each native/T3 test pass explicitly skips 100 optional TLC/renderer integrations because those tools are unavailable. All dependency-free and mocked installation tests pass. The complete upstream suite runs in a disposable copy; only its two top-level auto-provisioning probes become installed-only probes. A guard fails any attempted real mise install. Renderer failure tests run offline. No real model-check or PNG-render success is claimed.
- [Fresh-process loader and smoke](/tmp/p3stack-maint-46919880/cursor/final-loader/PASS.txt) passed with `openai-codex/gpt-6.1-sol:xhigh`, without substitution. Native and T3 replies are exactly `p3stack smoke ok`; stderr is empty. The local package, live doctor capabilities, and bridge prompt integration passed. The generated statechart help command also exited 0 without provisioning.
- [Independent scope review](/tmp/p3stack-maint-46919880/cursor/review/decision-scope.md) found no blockers. [Comment review](/tmp/p3stack-maint-46919880/cursor/comment-review.md) found no required deletions. Routing eval is skipped because routes and chains are unchanged, not because a validation failed.
- Initial generation and matcher failures, their repairs, and complete streams remain in the receipt directory. No failed run is represented as a pass. The committed push hook and independent landing verifier must pass on the rebased PR head before merge.

## Follow-up

Pocock remains at its independently checked upstream tip, with a clean tree and no PR or bump note. No dependency refresh, host update, live-settings edit, or fingerprint refresh is included. Live TLC and PNG checks remain optional coverage gaps. The user explicitly authorized updating existing #76 rather than opening a duplicate, then authorized merging the verified prerequisite and retargeting/revalidating this PR before merge. The owner-review bypass is authorized only after all validation passes. The earlier notes record their historical unmerged state.

## Second bump to 99b609a

### Pins

- Source: `cursor-plugins`, upstream `cursor/plugins`.
- Checkout: `vendor/pstack`, shared by cursor-plugins and owner-plugins.
- Old SHA: `9580c23696ac8d7abed0c166f2f9918800afb819`.
- Checked upstream main and candidate SHA: `99b609a72323b70204eab407c622f436e858e112`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/9580c23696ac8d7abed0c166f2f9918800afb819...99b609a72323b70204eab407c622f436e858e112).
- Maintenance PR: [#77](https://github.com/daniel-ballance/pi-packages/pull/77), shared by both sources.

### Upstream scope

The delta contains merge #810 and its three Tailscale commits: `59c03a6`,
`0b20c5e`, and `a29ce40`. Full commit and path receipts are
[here](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-upstream-stat.log) and [here](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-upstream-paths.log).

All six changed paths are outside the declared source roots:

- `.cursor-plugin/marketplace.json` and `README.md` change the Tailscale listing description.
- `third_party/tailscale/.cursor-plugin/plugin.json` changes its version and description.
- `third_party/tailscale/CHANGELOG.md` and `third_party/tailscale/README.md` describe that integration.
- `third_party/tailscale/skills/tailscale-setup/SKILL.md` extends personal and company tailnet setup, device posture, DNS, routes, private CAs, and troubleshooting.

The Tailscale skill requires Grok Bot's integration and is outside every declared
source skill root. It remains outside p3stack. No source map expansion is needed.
The [full upstream diff](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-full-upstream.diff) was reviewed.

### Decisions

The mapped `pstack/` subtree does not change. No skills need classification or repair.
The generated `poteto-help` skill changes seven commit-pinned guide links only.
The package's upstream metadata and both shared-checkout README pins follow the new SHA.

There are no new, renamed, removed, or behavior-changing skills within these sources.
No registry row, token rule, section hash, route, chain, or deny token changes.
Both source bump commands ran at the same candidate. The moved gitlink was staged
immediately before any pin check.

### Generated changes

Only provenance metadata and guide-link SHAs change. No agent changes.
The [first generated diff](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-generated-first.diff) and
[second generated diff](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-generated-second.diff) are identical
([comparison](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-generation-compare.log)).

### Verification

The session used Pi `openai-codex/gpt-6.1-sol:xhigh` with full-access permissions.
Installed Pi 1.4.0 ran the loader, doctor, and fresh-process smoke.
Development tests used the frozen repository dependencies. No host or lockfile changed.

All receipts are outside the checkout at `/tmp/p3stack-maint-dc08b4d5-20261024`.

- Current-pins `./scripts/check.sh`: exit 0, final line `Root check passed.` ([receipt](/tmp/p3stack-maint-dc08b4d5-20261024/baseline-root.log)).
- Current-pins generation, registry, and static host checks: exit 0 ([generation](/tmp/p3stack-maint-dc08b4d5-20261024/baseline-generation.log), [registry](/tmp/p3stack-maint-dc08b4d5-20261024/baseline-registry.log), [contract](/tmp/p3stack-maint-dc08b4d5-20261024/baseline-contract.log)).
- Authored registry: release, onboard-brownfield, p3stack-mode, and maintain-p3stack all emit. The router uses its authored template. Full coverage is 87 emitted, 24 dropped, 0 unclassified.
- `npm --prefix packages/p3stack run check`: exit 0, no errors ([receipt](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-final-package-check.log)). The 103 resource-orphan warnings are expected by the package guidance.
- `npm --prefix packages/p3stack test`: exit 0 in both host contexts ([receipt](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-final-package-test.log)).
- Final registry, static contract, and host lint: exit 0 ([registry](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-final-registry.log), [contract](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-final-contract.log), [host lint](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-final-host-lint.log)).
- Final `./scripts/check.sh`: exit 0, final line `Root check passed.` ([receipt](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-final-root.log)).
- Local package listed by `pi list`; real T3 doctor capabilities pass; fresh smoke replies exactly `p3stack smoke ok` with no tools or loader diagnostics ([run](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-final-loader-smoke.log), [stream](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-final-smoke.jsonl), [doctor](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-final-agent/p3stack/t3-contract.json)).
- Routes and chains do not change. Routing eval is skipped for that reason.
- Comment review found no comments to remove. Slop-strip and scope review found no unrelated changes ([review](/tmp/p3stack-maint-dc08b4d5-20261024/comment-review.json)).

### Follow-up

The portability prerequisite is already on the audited remote main through PR #75.
This branch starts at `67eed77e6d81e503ba768328e1fdd99ae3c36080`.
No dependency-refresh handoff is needed. No required validation remains blocked. The existing test suite skips optional TLC and renderer integration cases when those external tools are absent; this update does not claim a live model-check or PNG-render success.
The PR remains unmerged.
