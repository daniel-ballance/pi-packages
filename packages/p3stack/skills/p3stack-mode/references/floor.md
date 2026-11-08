# Quality floor

The floor is the part of the quality bar that holds with no setup and under every grant. Agents under pressure to reach green lower it quietly, so a script checks it rather than a reviewer's attention.

**The floor.** A change adds no suppression comments, skips or deletes no tests, adds no unimplemented stubs or swallowed errors, and weakens no threshold in `CONSTRAINTS.md` or in coverage, lint, or compiler configuration. When a project has a `CONSTRAINTS.md`, its thresholds join the floor; the `constraints` skill writes one.

**Check it.** From the repository, run `node <p3stack-mode directory>/scripts/floor-check.mjs`, where the directory is the one holding the p3stack-mode `SKILL.md`. It diffs against the merge-base with the default branch, including uncommitted and untracked files. Pass `--base <ref>` for another base and `--json` for structured output. Exit 0 means clean, 1 means findings, 2 means a usage or git error.

**Findings block done.** Remove each finding, or keep it with a reason: add `floor-ok: <reason>` on the same line, and repeat the reason in your report. A finding with no reason is not done, under either grant.
