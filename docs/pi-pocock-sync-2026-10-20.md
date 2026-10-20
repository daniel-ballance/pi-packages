# Pocock upstream refresh, 2026-10-20

## Source and scope

This refresh moves the `packages/pi-pocock-skills/vendor/matt-pocock` pin from
[`49dd158d1076134a641b33efb035946536778336`](https://github.com/mattpocock/skills/commit/49dd158d1076134a641b33efb035946536778336)
to [`5beb35b040e3de97e54fa9e386d7e42d15c295c2`](https://github.com/mattpocock/skills/commit/5beb35b040e3de97e54fa9e386d7e42d15c295c2),
upstream commit "chief-of-staff: keep memory in a dated, commit-cited wiki (#1304)".
It is the only commit in the range.

The submodule pin is the only code change. The generator, tests, generated
`skills/`, allowlist, and global settings are unchanged.

## Upstream changes

The upstream diff touches exactly two paths:

- `.changeset/chief-of-staff-wiki.md` is a new patch changeset.
- `skills/in-progress/chief-of-staff/SKILL.md` gains a "Wiki" section.

The new section tells `chief-of-staff` to keep its memory in a wiki of linked
Markdown pages with an `index.md`, maintained through ingest, query, and lint
operations. The wiki is a historical record. Every claim carries a date, and
every claim about code cites the commit it was true at. A changed claim gets a
new dated entry that marks the old one superseded.

`chief-of-staff` is not in the `ALLOW` list in `scripts/sync.sh`. The package
[`AGENTS.md`](../packages/pi-pocock-skills/AGENTS.md) excludes it as an
experimental multi-system personal workflow outside this collection's
engineering scope. The new wiki procedure does not change that reason, so the
skill stays excluded.

## Adopted skills

All eleven adopted upstream skill directories have the same git tree hash at
both pins:

| Upstream path | Tree hash |
|---|---|
| `skills/engineering/code-review` | `fee7bb5fdddc069d58cbea09b2c36b5a859eac05` |
| `skills/engineering/codebase-design` | `07ba1cd60efc12d0d3a083005c1d9651cf15e39a` |
| `skills/engineering/diagnosing-bugs` | `5fdd6cc53385395441910b026c72d71768e993d4` |
| `skills/engineering/domain-modeling` | `ea30ee454ba264543dbe40737973b1a5afb9f0e6` |
| `skills/engineering/grill-with-docs` | `eedaf2562c83155115e9c649fa3ecaac2e10e81d` |
| `skills/engineering/implement` | `4804b466ab26c9b9d8d42917547db133d1f20a9f` |
| `skills/engineering/research` | `0a6796c5667e95ed2301ba7381c123b4acb2ae1a` |
| `skills/engineering/tdd` | `667dbdd00c09d0e2189e082986e6a4d61a67c2a6` |
| `skills/productivity/grilling` | `28aceb4c9567b985cb47f7db88cf23c9f33af8b8` |
| `skills/productivity/wait-what` | `c8b050e6b8c711be1a9008ceacb2126914f0763e` |
| `skills/productivity/writing-for-agents` | `ad2925850efb8973a72d2e666f7a975f9a2d4a9b` |

The generated output is byte-identical. All 20 files under
`packages/pi-pocock-skills/skills` have the same SHA-256 before and after the
pin change, and `git diff -- packages/pi-pocock-skills/skills` is empty.

## Ingestion review

A read-only review regenerated the collection from both pins in fixtures and
found no ingestion defect. Every required translation rule still matched, and
no rule reported `DRIFT`. The allowlist and the ordered translation rules need
no change, so this refresh changes no ingestion process, generator, or test.

## Validation

These checks ran in the update worktree at the new pin:

- `./scripts/sync.sh` ran twice and exited 0 both times, with no `DRIFT`.
- `./scripts/sync.sh --check` exited 0 and reported that `skills/` is up to date.
- The SHA-256 manifest of `skills/` matched the pre-update manifest.
- Package `npm run check && npm test` exited 0. Skill lint reported 0 errors
  and 0 warnings, and every sync regression case passed.

The canonical root `./scripts/check.sh` passed on Node.js 26.12.0 with npm
12.2.0. It includes the package checks, sync regression tests, and packaging
checks against Pi 1.3.0.

`node scripts/skill-report.mjs --check ~ "$PWD"` passed after the pin change.
An isolated Pi 1.3.0 `DefaultResourceLoader` check loaded the candidate root
collection and then the two candidate packages with the five-skill user filter.
Both loads produced no skill or extension diagnostics, excluded `chief-of-staff`,
and selected pistack's `tdd`. The filtered load exposed only the four expected
model-invoked Pocock skills. Fresh interactive CLI and T3 prompt lists were not
exercised.

To rerun the comparison from the repository root:

```bash
pin() { git -C packages/pi-pocock-skills/vendor/matt-pocock "$@"; }
manifest() { find packages/pi-pocock-skills/skills -type f -print0 | sort -z | xargs -0 sha256sum; }
pin diff --stat 49dd158 5beb35b
for dir in $(pin ls-tree -d --name-only 5beb35b skills/engineering/ skills/productivity/); do
	[ "$(pin rev-parse "49dd158:$dir")" = "$(pin rev-parse "5beb35b:$dir")" ] || echo "changed: $dir"
done
pin checkout --detach 49dd158 && (cd packages/pi-pocock-skills && ./scripts/sync.sh) && manifest > /tmp/pocock-before.sha256
pin checkout --detach 5beb35b && (cd packages/pi-pocock-skills && ./scripts/sync.sh && ./scripts/sync.sh --check)
manifest | diff /tmp/pocock-before.sha256 - && git diff --exit-code -- packages/pi-pocock-skills/skills
```

The loop prints nothing when no skill directory under `skills/engineering` or
`skills/productivity` changed. Each `diff` prints nothing when the generated
output is identical.
