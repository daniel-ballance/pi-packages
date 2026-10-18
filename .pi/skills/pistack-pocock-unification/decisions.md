# Current decisions

Last run: 2026-10-18, pistack upstream `cursor/plugins@0b8e952` (pstack 0.15.26), pi-pocock-skills upstream `49dd158`.

Pocock refresh: all eleven names, invocation flags, coverage verdicts, and kept
skill dependencies remain unchanged. No settings or collection-filter edits were
needed. Real-loader checks passed in home and the update worktree; the root check
also exercises collection loading and pistack's `tdd` winner. Fresh interactive
CLI/T3 prompt lists were not exercised in this run.

The pstack update adds the user-invoked `create-formal-verification-skill` and
improves `ketchup` and TypeScript guidance. Formal verification adds no overlap
with the eleven Pocock skills: it creates a bounded, mutation-checked verification
skill, not a domain glossary, research report, or writing procedure. Every
coverage verdict below is unchanged; existing invocation flags, playbooks, and
cross-package pointers remain the same. No settings or collection-filter edits
are needed. `skill-report --check` passes for home and the update worktree; the
root package-loader tests separately load the candidate tree, including the new
skill, and verify that pistack's `tdd` wins without diagnostics. Fresh interactive
CLI/T3 prompt lists were not exercised. See the
[update validation](../../../docs/pistack-upstream-2026-10-18.md).

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
