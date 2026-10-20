# pi-pocock-skills

Matt Pocock's engineering skills, translated for the Pi harness. The skill
collection is a **generated vendor overlay**, not a hand-maintained fork.

`npm run check` checks translation drift, then lints the collection with the
repository's [`lint-skill`](../../scripts/lint-skill/README.md) through the
`scripts/check-skills.mjs` adapter, which selects this collection. `sync.sh`
calls that same adapter on the staged tree, in both regenerate and `--check`
modes, before it replaces `skills/`. Install from the repository root first
(`./scripts/ci-install.sh`); the package itself has no dependencies.

`skills/` is generated. Never edit it by hand. Edit the rules in
`scripts/sync.sh`, then re-run.

## Upstream

Vendored as a git submodule at `vendor/matt-pocock`, pointing at
<https://github.com/mattpocock/skills>.

The submodule gitlink is the authoritative pin; `sync.sh` prints the checked-out
revision. Fetching upstream and choosing a new pin are explicit maintenance
steps, never part of generation or CI.

## Why this package exists

Upstream writes for Claude Code. Pi implements the Agent Skills spec but differs
in four ways that break the skills as written. All four are verified against Pi
0.87.1 (`docs/skills.md`, `docs/slash-commands.md`):

1. **Pi has no `Skill` tool.** Upstream says "Call the Skill tool with
   `grilling`". In Pi a model loads a skill by `read`ing its `SKILL.md`.
2. **Skill commands are namespaced.** Upstream's `/grill-me` is `/skill:grill-me`
   in Pi.
3. **`/clear` does not exist in Pi.** The equivalents are `/new`, `/compact`,
   `/fork`, `/clone`.
4. **`argument-hint` is a prompt-template field**, silently ignored on skills.

Upstream also assumes a **team issue tracker** with reporters and label state
machines. These repos keep specs in repo docs, so the tracker references get
rewritten rather than configured.

## What we took

Eleven skills. This is the **dependency closure** of the eight we actually want,
not eight. `grill-with-docs` pulls in `grilling` + `domain-modeling`;
`implement` pulls in `tdd` + `code-review`; `tdd` pulls in `codebase-design`.
Taking a skill without its dependencies leaves it pointing at nothing.

| Skill | Bucket | Why |
|---|---|---|
| `grilling` | productivity | The interview primitive. Formalises the round/frontier rhythm these sessions already fall into. |
| `grill-with-docs` | engineering | Same interview, plus the `CONTEXT.md` / ADR paper trail. |
| `domain-modeling` | engineering | Dependency of `grill-with-docs`. Also the skill that seeds the `CONTEXT.md` the others consume. |
| `codebase-design` | engineering | Deep-module vocabulary. Dependency of `tdd`. |
| `code-review` | engineering | Two-axis Standards + Spec review. |
| `writing-for-agents` | productivity | Reference for writing skills and agent-facing docs. Translates cleanly. |
| `diagnosing-bugs` | engineering | Tight feedback-loop discipline. Ships its own HITL template. |
| `research` | engineering | Primary-source investigation to a cited Markdown file. |
| `wait-what` | productivity | Re-pitch in plain English. Needs a `CONTEXT.md` to be worth much. |
| `implement` | engineering | Spec/tickets → build → review → commit wrapper. |
| `tdd` | engineering | Red-green-refactor. Dependency of `implement`. |

## What we deliberately skipped

Do not add these without re-reading the reason.

| Skill | Reason |
|---|---|
| `to-spec`, `to-tickets`, `triage`, `wayfinder`, `setup-matt-pocock-skills` | All sit on a team issue tracker. These repos are solo and direct-to-repo. |
| `teach` | Wants a multi-session curriculum workspace with missions, quizzes and learning records. Explanations here are task-driven. |
| `to-questionnaire` | Formalises pulling requirements from an external stakeholder. There is no external stakeholder. |
| `ask-matt` | The router. Redundant once this table exists, and it is the most Claude-shaped file in the repo. |
| `improve-codebase-architecture` | Skipped for now. Needs the HTML report pipeline and a whole-codebase survey habit that is not in play yet. |
| `prototype` | Skipped for now. Its HTML/branch prototype shapes fit awkwardly against terminal-UI work. |
| `resolving-merge-conflicts` | Removed upstream; it was never bundled here. |
| `implement-spec`, `pr`, `retro` | Graduated upstream, but overlap p3stack's orchestration, shipping and reflection workflows. |
| `chief-of-staff` | Experimental multi-system personal workflow; outside this collection's engineering scope. |

## The translation rules

All in `scripts/sync.sh`, applied in order. Each carries a `min_total`, a drift
tripwire counted across the whole generated tree.

| Rule | Does |
|---|---|
| `skill-tool-twice` | `Call the Skill tool twice, for "X" and "Y".` → `Read \`../X/SKILL.md\` and \`../Y/SKILL.md\`, and follow both.` |
| `skill-tool-call-upper` / `-lower` | `Call/call the Skill tool with "X"` → `Read/read \`../X/SKILL.md\`` |
| `subagent-plural` / `-singular` | `sub-agent(s)` → `subagent(s)`, matching our tool naming |
| `subagent-spawn-review` | `Spawn both subagents in parallel` → `Spawn both reviewers with \`subagent_spawn\`, then \`subagent_wait\`` |
| `subagent-review-collect` | foreground calls → spawn both reviewers before waiting, then collect and verify both reports |
| `subagent-background` | research delegation → bounded child guidance with a direct-lookup fallback |
| `subagent-dispatch` | grilling's environment-fact paragraph → bounded child guidance with a direct-lookup fallback |
| `subagent-spawn-many` | `Spawn 3+ subagents in parallel` → up to three bounded children with `subagent_spawn`, wait/read/close |
| `subagent-design-twice` | `spin up parallel subagents` → `spawn parallel children with \`subagent_spawn\`` |
| `clear-to-new` | `/clear` → `/new` |
| `arg-hint` | drops `argument-hint:` frontmatter lines |
| slash-namespacing | `/<skillname>` → `/skill:<skillname>`, with a lookbehind that protects `../name/SKILL.md` paths and real Pi commands |
| `tracker-precondition` / `tracker-spec-source` | required, counted rewrites of `code-review`'s tracker prerequisites → repo-doc spec guidance |
| `tracker-ticket` | `implement` fetches tickets through a documented tracker workflow, or asks for ticket text if none is configured |
| `glossary-convention` / `glossary-map-heading` | upstream `GLOSSARY.md` / map / format references → the existing local `CONTEXT.md` convention, including the format resource filename |
| child delegation | writes one shared `skills/references/CHILD-DELEGATION.md` with separate Pi CLI and T3 Code branches and explicit Markdown pointers from child workflows |
| `hitl-resource-link` | makes the bundled HITL script discoverable through a Markdown link |
| `skill-resource-link` | turns translated sibling-skill paths into explicit dependency links |
| `tdd-command-link` / `review-command-link` | optional support for legacy slash commands; current upstream uses the skill-tool rules instead |

Ordering constraints that are easy to break:

- **Count, then apply, per rule, in order.** Several rules rewrite text an earlier
  rule produced (`sub-agent` → `subagent` → `spawn a child`). Counting everything
  against the original tree makes those chained rules report zero and false-alarm.
- **The tracker rules run before slash-namespacing.** Otherwise their source
  command has already become `/skill:setup-matt-pocock-skills` and never matches.
- **Resource links run after skill-tool translation and before slash-namespacing.**
  This makes generated `../name/SKILL.md` paths explicit links and preserves the
  `/skill:` command labels without rewriting link destinations. Project/output
  paths and code examples remain prose, not invented bundled dependencies.

`agents/openai.yaml` is dropped from the output. Pi never reads it;
`disable-model-invocation` in `SKILL.md` is the supported equivalent and is
already present where it matters.

## Drift tripwire

A rule with `min_total >= 1` that matches zero times means upstream reworded the
sentence and our translation silently stopped applying. `sync.sh` reports it as
`DRIFT`. Treat a drift report as a real finding: go read the new upstream wording
and update the rule.

Rules currently at `min_total 0` (`clear-to-new`, `arg-hint`,
`tdd-command-link`, `review-command-link`) support legacy/future wording. Current
upstream uses explicit Skill-tool calls for `implement`; output validation
independently requires its TDD and review dependency links. Required tracker
rewrites are counted like every other rule, not silently attempted.

Generation also rejects ambiguous source names, invalid regular expressions,
untranslated harness/glossary wording, colliding format resources, and broken
links in the staged tree. A lint error, an incomplete check, or a missing
linter refuses replacement. Warnings do not. Regression tests cover failure
preservation and failed-move recovery.

## Updating upstream

```bash
cd packages/pi-pocock-skills
./scripts/sync.sh --check          # what would change, before touching anything
old=$(git -C vendor/matt-pocock rev-parse HEAD)
git -C vendor/matt-pocock fetch origin main
new=$(git -C vendor/matt-pocock rev-parse FETCH_HEAD)
git -C vendor/matt-pocock log --oneline "$old..$new"
git -C vendor/matt-pocock diff "$old" "$new" -- skills/
git -C vendor/matt-pocock checkout --detach "$new"
./scripts/sync.sh                  # regenerate, watch for DRIFT
git diff -- skills/ scripts/       # review the semantic delta
./scripts/sync.sh --check
npm run check && npm test
```

Review `git diff skills/` before committing. Mechanical translation is cheap; the
thing you are looking for is upstream changing a **decision**, not a sentence.
Account for every adopted-skill change, renamed resource, and new upstream skill;
the allowlist admits nothing automatically. Keep the local `CONTEXT.md` contract:
upstream's glossary rename must not create a second vocabulary store in repos
already using this collection. Update translation rules, never generated files.
Re-run the project `p3stack-pocock-unification` skill after a sync, then run the
canonical root `./scripts/check.sh` from the repository root before pushing.

## Before first use

Run `domain-modeling` against `~/Code/pi-packages` if this repo needs a shared
glossary. It creates or updates `CONTEXT.md` lazily when terms are resolved;
`wait-what`, `grill-with-docs` and `code-review`'s spec axis consume it when
present.

## Installing

Add to `~/.pi/agent/settings.json`:

```json
"packages": ["../../Code/pi-packages/packages/pi-pocock-skills"]
```

Then `/reload`. Skills arrive as `/skill:<name>`.
