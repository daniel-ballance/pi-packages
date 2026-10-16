---
name: pistack-pocock-unification
description: Re-check which pi-pocock-skills skills load beside pistack, so pistack wins anything both cover. Use after a pistack or pi-pocock-skills sync, a skill added, renamed, or re-flagged in either, a Pi or T3 Code update, or when asked to redo the unification.
---

# pistack and pi-pocock-skills unification

The rule is that pistack wins anything both packages cover. The result must match in the Pi CLI and in T3 Code threads, inside this repository and outside it. [loader.md](loader.md) explains how Pi decides which skill loads. [decisions.md](decisions.md) holds the current verdicts. [lessons.md](lessons.md) holds what went wrong before. Read all three before step 3.

## Steps

1. Work in a worktree under `.pi/worktrees/`. Run `bash scripts/ci-install.sh` and `git submodule update --init` in it. Done when `git worktree list` shows it and `ls packages/subagents/node_modules` succeeds.
2. Capture the baseline. Run `node scripts/skill-report.mjs --check ~ ~/Code/pi-packages` from the worktree and keep the output. Done when the output is saved in the run's notes.
3. Inventory both packages. Run `grep -H -E '^(name|disable-model-invocation):' packages/{pistack,pi-pocock-skills}/skills/*/SKILL.md` and `ls packages/pistack/skills/poteto-mode/playbooks`. Done when every pocock skill in the `sync.sh` allowlist and every pistack skill name is listed.
4. Give every pocock skill a verdict with the coverage rule below. A pocock skill not yet in [decisions.md](decisions.md) starts as drop until you find no pistack handler for its request. Done when every pocock skill has a row in the coverage table.
5. Check links. Run `grep -rn -E '\.\./[a-z-]+/SKILL\.md|/skill:' packages/pi-pocock-skills/skills` and `grep -rn -i -E 'pocock|<each kept or dropped name>' packages/pistack/skills`. A kept skill must not depend on a dropped one. A pocock skill that pistack points at stays. Done when every link from a kept skill and every pistack pointer resolves to a kept skill.
6. Apply the verdicts in the two places listed under [Where the verdicts live](#where-the-verdicts-live). Done when both files list exactly the decided set.
7. Verify. Run `node scripts/skill-report.mjs --check ~ <worktree path>` and `./scripts/check.sh`. Both must pass. The main checkout passes only after the PR merges. Then start a fresh CLI session in `~` and in this repository, and open a fresh T3 thread on this project. In each, the pocock skills in the prompt's skill list are only the kept model-invoked ones, and `/skill:tdd` opens `packages/pistack/skills/tdd/SKILL.md`. Done when every check passes. Report anything you could not check as unverified.
8. Record. Update [decisions.md](decisions.md) and add any new lesson to [lessons.md](lessons.md). Open a PR from the worktree. Done when the PR exists.

## Coverage rule

Drop a pocock skill when pistack has a skill or playbook for the same request, even when pistack's procedure differs. Keep it when pistack has nothing a user would reach for with that request.

- A shared name always means drop. Only one copy loads, and pistack's must.
- A pocock skill that pistack points at always stays.
- A pocock skill that only chains dropped skills goes with them.
- A model-invoked pocock skill whose trigger words match a pistack playbook takes the request first. Drop it unless pistack has no handler.

## Where the verdicts live

- **User settings.** `~/.pi/agent/settings.json` is a symlink to `~/Work/omarchy-customizations/pi/settings.json`. Its `pi-pocock-skills` entry lists each kept skill as `skills/<name>/SKILL.md`. Paths in this file resolve from `~/.pi/agent`. Commit only `pi/settings.json` in that repository, because it often holds other uncommitted edits.
- **The collection.** The root `package.json` `pi.skills` list excludes every pocock skill whose name is also a pistack skill, as `!packages/pi-pocock-skills/skills/<name>`. Write the exclusion without a leading `./`, which matches nothing.

Keep `pi-pocock-skills` out of this repository's `.pi/settings.json`. A project entry for the same package replaces the user entry inside this repository.
