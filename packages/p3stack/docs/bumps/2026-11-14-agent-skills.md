# Agent skills bump on 2026-11-14

## Pins

- Source: `agent-skills`, upstream `addyosmani/agent-skills`.
- Checkout: `vendor/agent-skills`, not shared.
- Old SHA: `301b02b12bff98e4688e6984af6556802322bbde` (0.6.15).
- New SHA: `39b723ceebf81474d0557c1fecd01eddab585563` (0.6.16).
- [Upstream comparison](https://github.com/addyosmani/agent-skills/compare/301b02b12bff98e4688e6984af6556802322bbde...39b723ceebf81474d0557c1fecd01eddab585563).
- [Maintenance PR](https://github.com/daniel-ballance/pi-packages/pull/127).

## Upstream scope

- Many upstream commits (mostly merges of PRs #383, #514, #732, #744, #762, #778, #782, #785, #786), ending in `39b723c` "bump plugin manifests to 0.6.16".
- Emitted skills changed: `skills/constraint-driven-development/SKILL.md` (emitted as `constraints`), `skills/security-and-hardening/SKILL.md` and its two references (emitted as `security-hardening`).
- Dropped skills changed, all with an existing drop row: `code-review-and-quality`, `debugging-and-error-recovery`, `documentation-and-adrs`, `frontend-ui-engineering`, `planning-and-task-breakdown`, `spec-driven-development`, `test-driven-development`.
- Review scope, not emitted: plugin manifests and version (0.6.16), `commands/build.toml` and `commands/spec.toml` with their `.claude` and `.gemini` copies (delta-spec support), the `evals/` cases and fixtures, `scripts/` for the eval runner and link validator, and the plugin-install workflow. None maps to an emitted path. No new skill appeared.
- Borrowed: `skills/constraint-driven-development/SKILL.md` is borrowed by `authored/skills/p3stack-mode/references/floor.md` and `authored/skills/p3stack-mode/scripts/floor-check.mjs`. The upstream change drops `--validate` from the `depcruise` command in one table row. The Floor idea (catch agents gaming green) is unchanged, and neither restating file mentions `depcruise`, so no edit is needed.

## Decisions

- No new, renamed, or removed skill, so no registry row. The seven changed dropped skills keep their existing drop rows and reasons.
- No registry, token, section, patch, route, chain, or deny-token change.
- Borrowed path: reviewed and still holds, as above.

## Generated changes

- `constraints`: the architecture row uses `depcruise src` instead of `depcruise --validate src`.
- `security-hardening` `SKILL.md`: OWASP citations move to the 2025 edition (`A06:2025`, `A01:2025`, `A03:2025`).
- `security-hardening/references/security-checklist.md`: the OWASP Top 10 table is renumbered to the 2025 edition.
- `security-hardening/references/hardening-patterns.md`: the session example fails at startup when `SESSION_SECRET` is missing.
- `README.md`: the agent-skills pin and version move to the candidate.
- The second generation produced a diff identical to the first.

## Verification

See the PR body for the gate results. The current-pins root gate, `generate.mjs --check`, the registry check (`0 unclassified`), the static T3 pin check, the loader check, and the fresh-process smoke with `--model claude-subscription/claude-sonnet-5-5:high` passed before the bump. Live T3 catalog check: `orchestrator_capabilities` returned the required tools; `/p3stack doctor` is a Pi slash command and was not run. Routing eval skipped because routes and chains did not change.

## Follow-up

None.
