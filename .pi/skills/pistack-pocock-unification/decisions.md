# Current decisions

Last run: 2026-10-20, pistack upstream `cursor/plugins@d457567` (pstack 0.15.28), pi-pocock-skills upstream `5beb35b`.

The pi-pocock-skills pin moves from `49dd158` to `5beb35b`. Upstream changed only
the excluded `chief-of-staff` skill and its changeset. All eleven adopted skill
trees are unchanged, and the generated collection is byte-identical. All eleven
coverage verdicts below remain unchanged. Invocation flags, playbooks, kept
dependencies, and cross-package pointers are unchanged. No settings or
collection-filter edits are needed.

`skill-report --check` passed for home and the main checkout before the pin
change, and for home and the update worktree afterward. The package checks,
tests, and canonical root check pass at the new pin. Isolated Pi 1.3.0 loader
checks of the candidate collection and filtered packages select pistack's `tdd`
without skill or extension diagnostics. Fresh interactive CLI and T3 prompt
lists were not exercised. See the
[sync audit](../../../docs/pi-pocock-sync-2026-10-20.md). The previous run added
pstack's `maintain-formal-verification-skill` and is recorded in the
[pistack update validation](../../../docs/pistack-upstream-2026-10-19.md).

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
