# Current decisions

Last run: 2026-10-20, p3stack upstream `cursor/plugins@88d4751` (pstack 0.15.29), pi-pocock-skills upstream `5beb35b`.

The pstack refresh changes `sharpen` to return a rewritten prompt rather than
execute the task. Its help and example agree. The concurrent Pocock refresh
moves `49dd158` to `5beb35b`, changing only the excluded `chief-of-staff` skill
and its changeset. All eleven adopted Pocock skill trees are unchanged.
No skills, playbooks, or invocation flags were added or removed. All eleven
coverage verdicts below remain unchanged. Kept dependencies and cross-package
pointers are unchanged. No settings or collection-filter edits are needed.

`skill-report --check` passes for home, the main checkout, and the update worktree.
Live settings still select the main checkout. The root check's isolated Pi 1.3.0
loader tests load the candidate collection and p3stack package directly and verify
that p3stack's `tdd` wins without skill diagnostics. Fresh interactive CLI and T3
prompt lists were not exercised. See the
[p3stack update validation](../../../docs/pistack-upstream-2026-10-20.md) and
[Pocock sync audit](../../../docs/pi-pocock-sync-2026-10-20.md).

## Coverage table

| Pocock skill | p3stack handler | Verdict |
|---|---|---|
| `tdd` | `tdd` skill, Bug fix playbook step 5 | drop, same name |
| `code-review` | `interrogate`, `blast-radius`, `no-comments` | drop |
| `diagnosing-bugs` | Bug fix and Perf issue playbooks | drop |
| `codebase-design` | `architect`, `arena` | drop |
| `implement` | Feature playbook | drop, it chains `tdd` and `code-review` |
| `wait-what` | `bro` | drop |
| `research` | none. `how` and `why` answer in chat from the code. `research` writes a cited file from outside sources | keep |
| `writing-for-agents` | none. p3stack points at it in `poteto-mode/references/host-capabilities.md` | keep |
| `domain-modeling` | none. `principle-model-the-domain` is about code structure, not `CONTEXT.md` and ADRs | keep |
| `grilling` | none. `interrogate` reviews a change with other models and does not interview the user | keep |
| `grill-with-docs` | none. It combines `grilling` and `domain-modeling` | keep |

## Other decisions

- **Filter location.** The kept list lives only in the user settings. This repository's `.pi/settings.json` does not list `pi-pocock-skills`.
- **The collection.** The root `package.json` excludes pocock's `tdd`, so p3stack's loads. It still ships the other pocock skills, because the collection serves other users.
- **p3stack-mode.** The mode stays opt-in per session. The operator chose not to turn it on by default.
- **The check.** `scripts/skill-report.mjs --check` fails when p3stack loses a name. `packages/subagents/test/package-layout.test.ts` asserts which `tdd` file the collection loads and that it raises no skill diagnostics.
