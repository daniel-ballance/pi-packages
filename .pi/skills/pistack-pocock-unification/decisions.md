# Current decisions

Last run: 2026-10-19, pistack upstream `cursor/plugins@d457567` (pstack 0.15.28), pi-pocock-skills upstream `49dd158`.

The pstack refresh adds the user-invoked `maintain-formal-verification-skill`,
improves its creator, and offers formal verification during setup. It maintains
verification models and checks against covered code. It does not replace a domain
glossary, research report, or writing procedure. All eleven coverage verdicts
below remain unchanged. Existing invocation flags, playbooks, kept dependencies,
and cross-package pointers are unchanged. No settings or collection-filter edits
are needed.

`skill-report --check` passes for home and the update worktree. Live settings
still select the main checkout. A separate isolated Pi 1.3.0 loader check loads
the candidate collection and pistack package directly, finds the new skill with
model invocation disabled, and verifies that pistack's `tdd` wins without skill
diagnostics. The full root check also passes. Fresh interactive CLI and T3 prompt
lists were not exercised. See the
[update validation](../../../docs/pistack-upstream-2026-10-19.md).

## Coverage table

| Pocock skill | pistack handler | Verdict |
|---|---|---|
| `tdd` | `tdd` skill, Bug fix playbook step 5 | drop, same name |
| `code-review` | `interrogate`, `blast-radius`, `no-comments` | drop |
| `diagnosing-bugs` | Bug fix and Perf issue playbooks | drop |
| `codebase-design` | `architect`, `arena` | drop |
| `implement` | Feature playbook | drop, it chains `tdd` and `code-review` |
| `wait-what` | `bro` | drop |
| `research` | none. `how` and `why` answer in chat from the code. `research` writes a cited file from outside sources | keep |
| `writing-for-agents` | none. pistack points at it in `poteto-mode/references/host-capabilities.md` | keep |
| `domain-modeling` | none. `principle-model-the-domain` is about code structure, not `CONTEXT.md` and ADRs | keep |
| `grilling` | none. `interrogate` reviews a change with other models and does not interview the user | keep |
| `grill-with-docs` | none. It combines `grilling` and `domain-modeling` | keep |

## Other decisions

- **Filter location.** The kept list lives only in the user settings. This repository's `.pi/settings.json` does not list `pi-pocock-skills`.
- **The collection.** The root `package.json` excludes pocock's `tdd`, so pistack's loads. It still ships the other pocock skills, because the collection serves other users.
- **pistack-mode.** The mode stays opt-in per session. The operator chose not to turn it on by default.
- **The check.** `scripts/skill-report.mjs --check` fails when pistack loses a name. `packages/subagents/test/package-layout.test.ts` asserts which `tdd` file the collection loads and that it raises no skill diagnostics.
