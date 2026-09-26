# agent-skills

Matt Pocock's engineering skills, translated for the Pi harness. This package is a
**generated vendor overlay**, not a hand-maintained fork.

`skills/` is generated. Never edit it by hand. Edit the rules in
`scripts/sync.sh`, then re-run.

## Upstream

Vendored as a git submodule at `vendor/matt-pocock`, pointing at
<https://github.com/mattpocock/skills>.

Current pin: `c55ee46` (shallow, depth 50).

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
| `resolving-merge-conflicts` | Skipped for now. Cheap insurance if concurrent sessions start colliding; revisit then. |

## The translation rules

All in `scripts/sync.sh`, applied in order. Each carries a `min_total`, a drift
tripwire counted across the whole generated tree.

| Rule | Does |
|---|---|
| `skill-tool-twice` | `Call the Skill tool twice, for "X" and "Y".` → `Read \`../X/SKILL.md\` and \`../Y/SKILL.md\`, and follow both.` |
| `skill-tool-call-upper` / `-lower` | `Call/call the Skill tool with "X"` → `Read/read \`../X/SKILL.md\`` |
| `subagent-plural` / `-singular` | `sub-agent(s)` → `subagent(s)`, matching our tool naming |
| `subagent-spawn-review` | `Spawn both subagents in parallel` → `Spawn both reviewers with \`subagent_spawn\`, then \`subagent_wait\`` |
| `subagent-background` | `Spin up a **background agent**` → `Spawn a child with \`subagent_spawn\`` |
| `subagent-dispatch` | `dispatch a subagent to find it` → `spawn a child with \`subagent_spawn\` to find it` |
| `subagent-design-twice` | `spin up parallel subagents` → `spawn parallel children with \`subagent_spawn\`` |
| `clear-to-new` | `/clear` → `/new` |
| `arg-hint` | drops `argument-hint:` frontmatter lines |
| slash-namespacing | `/<skillname>` → `/skill:<skillname>`, with a lookbehind that protects `../name/SKILL.md` paths and real Pi commands |
| tracker swap | `code-review`'s issue-tracker precondition → "the spec is the repo doc the conversation names" |

Two ordering constraints that are easy to break:

- **Count, then apply, per rule, in order.** Several rules rewrite text an earlier
  rule produced (`sub-agent` → `subagent` → `spawn a child`). Counting everything
  against the original tree makes those chained rules report zero and false-alarm.
- **The tracker swap runs before slash-namespacing.** Otherwise its literal source
  text has already become `/skill:setup-matt-pocock-skills` and never matches.

`agents/openai.yaml` is dropped from the output. Pi never reads it;
`disable-model-invocation` in `SKILL.md` is the supported equivalent and is
already present where it matters.

## Drift tripwire

A rule with `min_total >= 1` that matches zero times means upstream reworded the
sentence and our translation silently stopped applying. `sync.sh` reports it as
`DRIFT`. Treat a drift report as a real finding: go read the new upstream wording
and update the rule.

Rules currently at `min_total 0` (`skill-tool-call-upper`, `clear-to-new`,
`arg-hint`) are kept for future-proofing. None of our eleven skills triggers them
today. That is expected, not a bug.

## Updating upstream

```bash
cd agent-skills
./scripts/sync.sh --check          # what would change, before touching anything
git -C vendor/matt-pocock fetch --depth 50 origin main
git -C vendor/matt-pocock checkout <new-sha>
./scripts/sync.sh                  # regenerate, watch for DRIFT
git diff skills/                   # review the semantic delta
```

Review `git diff skills/` before committing. Mechanical translation is cheap; the
thing you are looking for is upstream changing a **decision**, not a sentence.

## Before first use

Run `domain-modeling` against `~/Code/pi-packages` to seed a `CONTEXT.md`.
`wait-what`, `grill-with-docs` and `code-review`'s spec axis all point at it and
it does not exist yet.

## Installing

Add to `~/.pi/agent/settings.json`:

```json
"packages": ["../../Code/pi-packages/packages/agent-skills"]
```

Then `/reload`. Skills arrive as `/skill:<name>`.
