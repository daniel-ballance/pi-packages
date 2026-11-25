# Agent skills bump on 2026-11-25

## Pins

- `agent-skills` takes `vendor/agent-skills` from `39b723ceebf81474d0557c1fecd01eddab585563` to `e997ac5b9a74eab332d5e9793bb38a38c8cfdd74` (0.6.18).
- [Upstream comparison and commits](https://github.com/addyosmani/agent-skills/compare/39b723ceebf81474d0557c1fecd01eddab585563...e997ac5b9a74eab332d5e9793bb38a38c8cfdd74) and [maintenance PR for this branch](https://github.com/daniel-ballance/pi-packages/pulls?q=is%3Apr+head%3Achore%2Fp3stack-agent-skills-tip-20261125-e997ac5).

## Scope and decisions

- Drop `skills/accessibility-engineering/SKILL.md` and its resources. The audit workflow links to the deferred frontend skill and an audit persona that p3stack does not ship. No skill was renamed or removed. Keep the verdicts for the other dropped skills.
- Keep one installed copy of each security and observability checklist. The upstream skill-local copies are byte-for-byte duplicates of the already mapped files, so exclude the duplicates. For `agent-skills-checklist-paths`, replace the match `\.\./\.\./references/` with `references/shared/`. For `agent-skills-checklist-patterns`, replace `\.\./\.\./\.\./references/` with `\.\./references/shared/`. Both rules retain their output paths and minimum of one match.
- The plugin release, commands, audit persona, docs, hooks, CI, evals, scripts, and root accessibility checklist are outside the output map. The attributes file marks the skill-local copies as generated. Review stance still holds: the borrowed doubt-driven review skill only changes links to its orchestration reference.
- No route, chain, section overlay, or deny-token change.

## Generated changes

- `constraints` reports floor-guard findings by file and line without echoing source lines that might contain secrets.
- `security-hardening` labels the URL precheck as incomplete and explains what a defensive HTTP transport must enforce. The installed checklist paths do not change.
- The README records the new pin. See the maintenance PR for the second-generation diff check and candidate receipts.

## Verification

The [base commit](https://github.com/daniel-ballance/pi-packages/commit/5c14baeae63f7d734a78b4d0148180c9bdee0840) passed the root check, registry check, live T3 inventory, loader check, and fresh-process smoke. The routing eval does not apply because routes and chains did not change. See the maintenance PR for the candidate checks.
