# Lessons from earlier runs

- **Check the project settings first.** The first inventory read only `~/.pi/agent/settings.json` and missed that this repository's `.pi/settings.json` replaced it. That file is why pocock's `tdd` won inside the repository.
- **Ask the loader, not the docs.** Running Pi's `DefaultResourceLoader` turned an inferred `tdd` winner into an observed one in seconds. `scripts/skill-report.mjs` is that probe.
- **Compare paths and diagnostics, not names.** The collection's old `!./packages/pistack/skills/tdd` exclusion never matched, because of the leading `./`. The layout test compared skill names only, and both copies are named `tdd`, so it passed for weeks while Pi raised a collision.
- **Treat overlaps as the real problem.** Only one name collides. The skills that take requests from pistack are model-invoked pocock skills with different names.
- **Check what pistack points at before you drop anything.** pistack defers to pocock's `writing-for-agents`.
- **Write the rule before the verdicts, then check every verdict against it.** The first draft's rule said "same deliverable", while its verdicts dropped skills that only handled the same request. A reviewer on a different model caught it.
- **Live settings drift.** Pi and Omarchy write to the linked settings file, so it holds uncommitted edits. When it lived in `omarchy-customizations`, a plain commit swept weeks of them in under the wrong message. Run `git diff global/settings.json` in the main checkout before you change it.
- **Do not add keys to `pistack.json` casually.** `resolveRoles()` in `packages/pistack/extensions/pistack/src/roles.ts` ignores the whole file when it has an unknown field.
- **Old worktrees keep their own `.pi/settings.json`.** A T3 thread in `.pi/worktrees/<name>` loads that worktree's copy.
- **An upstream rename may be a local convention boundary.** Pocock renamed its glossary files to `GLOSSARY.md`; this collection keeps `CONTEXT.md` because existing repos and pistack integrations already consume it. Translate both contents and resource filenames, and check the links after generation.
- **A fresh worktree has no `node_modules` and no submodules.** Run `bash scripts/ci-install.sh` and `git submodule update --init` in it before `./scripts/check.sh`, package tests, or `scripts/skill-report.mjs`. Without the submodules, the pocock sync check reports every skill as hand-edited.
