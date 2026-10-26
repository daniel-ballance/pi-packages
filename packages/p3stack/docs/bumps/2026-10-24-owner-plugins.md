# owner-plugins bump on 2026-10-24

## Pins

- Source: `owner-plugins`, upstream `cursor/plugins`.
- Checkout: `vendor/pstack`, shared with `cursor-plugins`. Both use [maintenance PR #76](https://github.com/daniel-ballance/pi-packages/pull/76).
- Audited original pin: `88d47514b82e7c44f00f2b2a72ff6dd12158038c`.
- Previous PR candidate: `8b3326d99fd4b993cb33a24dad8af03175c642c5`.
- New upstream tip: `9580c23696ac8d7abed0c166f2f9918800afb819`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/88d47514b82e7c44f00f2b2a72ff6dd12158038c...9580c23696ac8d7abed0c166f2f9918800afb819).
- Audited base is separate portability [PR #75](https://github.com/daniel-ballance/pi-packages/pull/75), commit `04a2cc918836bb822ecb2836f61d56ce07584285`, now merged as `2b5b44dc49765f628f173e0f2252c24a4ce7249f`.

## Upstream scope

Both shared-source bump commands use the same final candidate. The owner command reports no additional movement. Complete diffs and tree comparisons from the audited original pin find no changes under `dyl-stack/` or `thermos/`, including unmapped files. The [Cursor note](2026-10-24-cursor-plugins.md) and [independent scope review](/tmp/p3stack-maint-46919880/cursor/review/decision-scope.md) account for the checkout's remaining commits and packaging.

## Decisions

Keep all five emitted owner skill rows, maps, token rules, overlays, routes, chains, and tests unchanged. No owner skill is new, renamed, removed, or behavior-changing. No owner min-match or section repair is needed. Keep every deny token.

## Generated changes

Only the README's owner-source pin advances. Owner skill and agent content stays unchanged. The shared generated diff is reproducible, as shown by [generation-identical](/tmp/p3stack-maint-46919880/cursor/generation-identical.exit).

## Verification

Shared candidate receipts are under `/tmp/p3stack-maint-46919880/cursor/`, with complete command, stdout, stderr, and exit-code files.

- The audited current-pin [root gate](/tmp/p3stack-maint-46919880/portability/root.stdout), baseline generation/registry/static-host checks, and [loader smoke](/tmp/p3stack-maint-46919880/baseline-loader/PASS.txt) passed before the bumps.
- Candidate package checks, tests, registry, static host contract, host lint, generator check, and [root gate](/tmp/p3stack-maint-46919880/cursor/root.stdout) passed. The registry reports `87 emitted, 24 dropped, 0 unclassified` and the root ends with `Root check passed.`.
- [Final loader and smoke](/tmp/p3stack-maint-46919880/cursor/final-loader/PASS.txt) passed with explicit `openai-codex/gpt-6.1-sol:xhigh`: local package listed, exact native/T3 replies, no loader errors, live doctor capabilities, and bridge prompt integration.
- Routing eval is skipped because routes and chains are unchanged. The Cursor statechart suite explicitly skips 100 optional TLC/renderer integrations per host pass. No owner coverage is skipped or removed by this update, and no real TLC or PNG success is claimed.
- [Scope review](/tmp/p3stack-maint-46919880/cursor/review/decision-scope.md) found no blockers. The push hook and independent landing verifier must pass on the rebased PR head before merge.

## Follow-up

No separate owner PR, dependency refresh, or host update is needed. The user authorized a continuation of existing #76 to avoid a duplicate, then authorized merging #75 and retargeting/revalidating #76 on main before merge. The owner-review bypass is authorized only after validation passes. Earlier notes retain their historical unmerged state.

## Second bump to 99b609a

### Pins

- Source: `owner-plugins`, upstream `cursor/plugins`.
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

Neither the mapped `dyl-stack/` nor the mapped `thermos/` subtree changes.
The shared pin advances with cursor-plugins. No owner skill or agent content changes.
The shared README pin and the Cursor provenance links follow the new SHA.

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
