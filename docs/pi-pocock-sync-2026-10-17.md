# Pocock upstream refresh — 2026-10-17

## Source and scope

Compared the committed pin [`c55ee46073ed923f86ce59a5eb3b6d895095d1b7`](https://github.com/mattpocock/skills/commit/c55ee46073ed923f86ce59a5eb3b6d895095d1b7)
with fetched upstream main [`49dd158d1076134a641b33efb035946536778336`](https://github.com/mattpocock/skills/commit/49dd158d1076134a641b33efb035946536778336).
The original pin passed `sync.sh --check` before updating. At the new pin the old
generator correctly reported two obsolete required slash-command rules, but its
uncounted tracker replacements would silently have missed upstream's new wording.

Only the submodule pin, generator, tests, generated skills and maintenance notes
change. No upstream file was edited. The eleven-skill allowlist and licensing
remain unchanged. Newly graduated `implement-spec`, `pr`, and `retro` overlap
pistack workflows and were not added. Experimental `chief-of-staff` and the
changed wizard/tracker/install tooling remain outside the allowlist;
`resolving-merge-conflicts` was removed upstream and was never bundled.

## Manual semantic review

Reviewed the upstream diff for every adopted skill, then read the generated
delta and changed skill bodies, including their linked resources.

| Adopted skill | Result |
|---|---|
| `code-review` | Preserve exhaustive standards-file discovery. Translate foreground calls to starting both reviewers before waiting and collecting verified reports. Keep the existing repository-doc spec source rather than introducing a tracker prerequisite. |
| `diagnosing-bugs` | Preserve the requirement to diff a forced mutation against a pristine copy before trusting the red. |
| `grilling` | Preserve question wording where “yes” accepts the recommendation. |
| `implement` | Preserve ticket fetching/title confirmation through a documented tracker, with a ticket-text fallback when none is configured. Translate the new Skill-tool calls to explicit TDD/review dependency links. |
| `tdd` | Preserve per-seam notes on what each proposed seam catches and misses. |
| `domain-modeling` | Translate the upstream glossary rename back to this collection's existing `CONTEXT.md`, map and format-resource convention. Generated files remain byte-identical to the previous convention. |
| `codebase-design`, `wait-what` | Same convention translation; otherwise unchanged. |
| `grill-with-docs`, `research`, `writing-for-agents` | Upstream skill bodies/resources unchanged. |

The shared child reference now separates Pi CLI mechanics from T3-owned
`delegate_task`/`task_status` mechanics, including new review rounds and stable
retry keys. No new tool implementation or host API is introduced.

## Ingestion improvements

- Count required tracker and reviewer-collection rewrites with drift tripwires.
- Retain legacy slash invocation support as optional, while independently
  requiring `implement`'s TDD and review dependency links in generated output.
- Translate glossary contents and the bundled filename together; reject resource
  collisions instead of overwriting one source.
- Reject ambiguous upstream skill names and propagate regex errors rather than
  disguising them as zero matches.
- Reject untranslated Skill-tool, foreground and glossary prose before replacing
  committed output. Preserve staged validation and move-failure recovery.
- Remove the stale manually cached pin from package guidance; document the
  explicit fetch/review/pin/regenerate/check procedure.

Regression cases cover every new required tracker/collection rule, ambiguous
sources, invalid optional regexes, untranslated text, glossary collisions,
semantic updates, dependency loss, legacy commands, byte-identical repeated
generation, and the existing failure-preservation/recovery cases.

## Validation

- Package `npm run check`: deterministic output matches; skill lint has **zero
  errors and zero warnings**.
- Package `npm test`: all sync regression cases pass, including byte-identical
  regeneration and failure recovery.
- Canonical root `./scripts/check.sh`: **passed in both CI layouts**, npm and
  pnpm 12.6.0, on Node.js 22.19.0. Each layout used locked dependencies installed
  by `./scripts/ci-install.sh locked`; manager switching removed only installed
  dependency directories, leaving both lockfiles unchanged.
- `git diff --check`: passed.
- Real Pi loader: `node scripts/skill-report.mjs --check ~ <update-worktree>`
  passed. All eleven coverage verdicts and invocation flags are unchanged;
  kept skills depend only on kept skills, and the collection loads pistack's
  `tdd` without a collision. Global settings were inspected and left untouched.
- Independent read-only review found no blocking findings and separately passed
  package checks, lint and tests.

Fresh interactive CLI/T3 prompt-list smoke tests were not exercised. The real
loader probe and root packaging tests cover discovery; live model behavior is
not established by these deterministic checks.
