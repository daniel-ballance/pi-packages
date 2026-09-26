# agent-skills

Matt Pocock's engineering skills, translated for Pi. Eleven skills covering
design interviews, domain modelling, deep-module design, TDD, two-axis code
review, disciplined bug diagnosis, and cited research.

This is a **generated vendor overlay**. `skills/` is produced by
`scripts/sync.sh` from a git submodule of upstream. Read [AGENTS.md](AGENTS.md)
before changing anything in here.

## Install

Add to `~/.pi/agent/settings.json`:

```json
"packages": ["../../Code/pi-packages/packages/agent-skills"]
```

Then `/reload`. Skills arrive as `/skill:<name>`.

## The eleven

**Design and alignment**

- `grilling`, `grill-with-docs` relentless interview to a shared understanding,
  the second one leaving an ADR and glossary trail
- `domain-modeling` sharpen terms, resolve overloaded words, record ADRs
- `wait-what` re-pitch the last thing that did not land, in plain English

**Shape and build**

- `codebase-design` deep-module vocabulary: module, interface, depth, seam,
  adapter, leverage, locality
- `tdd` red-green-refactor at pre-agreed seams
- `implement` spec or tickets to build to review to commit

**Review and investigation**

- `code-review` two axes, Standards and Spec, run as parallel children
- `diagnosing-bugs` no hypothesis until a tight feedback loop goes red on this bug
- `research` primary sources to a cited Markdown file, run as a child
- `writing-for-agents` how to write skills and agent-facing docs that behave

## Before first use

Seed a `CONTEXT.md` in the repo you work in. Several of these skills point at it
and it does not exist yet in `pi-packages`.
