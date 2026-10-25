# owner-plugins bump on 2026-10-24

## Pins

- Source: `owner-plugins`, upstream `cursor/plugins`.
- Checkout: `vendor/pstack`, shared by cursor-plugins and owner-plugins.
- Old SHA: `9580c23696ac8d7abed0c166f2f9918800afb819`.
- Checked upstream main and candidate SHA: `99b609a72323b70204eab407c622f436e858e112`.
- [Upstream comparison](https://github.com/cursor/plugins/compare/9580c23696ac8d7abed0c166f2f9918800afb819...99b609a72323b70204eab407c622f436e858e112).
- Maintenance PR: URL recorded after creation.

## Upstream scope

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

## Decisions

Neither the mapped `dyl-stack/` nor the mapped `thermos/` subtree changes.
The shared pin advances with cursor-plugins. No owner skill or agent content changes.
The shared README pin and the Cursor provenance links follow the new SHA.

There are no new, renamed, removed, or behavior-changing skills within these sources.
No registry row, token rule, section hash, route, chain, or deny token changes.
Both source bump commands ran at the same candidate. The moved gitlink was staged
immediately before any pin check.

## Generated changes

Only provenance metadata and guide-link SHAs change. No agent changes.
The [first generated diff](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-generated-first.diff) and
[second generated diff](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-generated-second.diff) are identical
([comparison](/tmp/p3stack-maint-dc08b4d5-20261024/cursor-generation-compare.log)).

## Verification

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

## Follow-up

The portability prerequisite is already on the audited remote main through PR #75.
This branch starts at `67eed77e6d81e503ba768328e1fdd99ae3c36080`.
No dependency-refresh handoff is needed. No behavior or validation remains blocked.
The PR remains unmerged.
