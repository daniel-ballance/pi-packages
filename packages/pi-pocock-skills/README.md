# pi-pocock-skills

Matt Pocock's engineering skills, translated for Pi. Eleven skills covering
design interviews, domain modelling, deep-module design, TDD, two-axis code
review, disciplined bug diagnosis, and cited research.

The package also ships [`lint-skill`](docs/lint-skill.md), an offline JavaScript
CLI for validating Pi skill frontmatter, explicit references, resource depth,
and orphaned files. It can lint skills outside this package.

The skill collection is a **generated vendor overlay**. `skills/` is produced by
`scripts/sync.sh` from a git submodule of upstream. Read [AGENTS.md](AGENTS.md)
before changing anything in here.

## Install

Add to `~/.pi/agent/settings.json`:

```json
"packages": ["../../Code/pi-packages/packages/pi-pocock-skills"]
```

Then `/reload`. Skills arrive as `/skill:<name>`.

## Lint a skill

Requires Node.js 22.19 or newer. From this package directory:

```sh
npm ci --ignore-scripts
node scripts/lint-skill.mjs /path/to/my-skill
node scripts/lint-skill.mjs --resource-root /path/to/skills /path/to/skills/my-skill
```

The npm binary is `lint-skill`; Pi package installation does not necessarily put
it on your shell PATH. See [the command guide](docs/lint-skill.md) for JSON output,
strict mode, explicit exceptions, and the Pi-specific root-relative link contract.

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

If the work needs a shared glossary, run `domain-modeling` in the repo you work
in. It creates or updates `CONTEXT.md` lazily when terms are resolved.

## Attribution and license

The shipped skills are derived from [Matt Pocock's skills](https://github.com/mattpocock/skills)
and translated for Pi. The upstream MIT license and copyright notice are shipped
in [LICENSE](LICENSE).
