# How Pi loads the two packages

These facts describe Pi 1.3.0 and T3 Code nightly 20261016. `scripts/skill-report.mjs` uses Pi's own loader, so trust its output over this file when they disagree, and fix this file.

**Packages.** Each package declares `pi.skills: ["./skills"]`. A settings entry narrows that set with a `skills` list of paths, globs, and `!` exclusions. A filter cannot add a path the package did not declare. A filter matches paths, not frontmatter names.

**Pattern matching.** A `!` pattern is a glob compared with the path relative to the base it belongs to, and a leading `./` is kept, so it matches nothing. In the root `package.json` manifest the base is the repository root, so `!packages/pi-pocock-skills/skills/tdd` works and `!./packages/pi-pocock-skills/skills/tdd` does not. In a settings entry the base is the package root, so the form is `!skills/tdd/SKILL.md`. Exact `+` and `-` patterns do strip a leading `./`.

**Package identity.** Pi identifies a local package by its absolute path. It reads project settings (`<cwd>/.pi/settings.json`, only for a trusted project) before user settings (`~/.pi/agent/settings.json`). When both list the same package, the project entry wins and the user entry is dropped. The two filters do not merge. Project settings load only from the exact working directory.

**Trust.** `~/.pi/agent/trust.json` holds `{"/home": true}`, so every project under `/home` is trusted.

**Name collisions.** Pi keeps the first skill with a given name and records a `collision` diagnostic for the rest. Project and user skill directories rank above packages. All package skills share one rank, project package entries come before user package entries, and inside one package the manifest order decides. Pi has no setting that picks a winner by package.

**Model visibility.** A skill with the boolean `disable-model-invocation: true` is hidden from the model's skill list. `/skill:<name>` still runs it. The flag does not settle a collision. In pistack, every skill except `setup-pstack` sets it. In pi-pocock-skills, `wait-what`, `grill-with-docs`, and `implement` set it.

**pistack-mode.** pistack routes requests only while `/pistack-mode on` is set for the session. It starts off in every new session. With it off, the model sees almost none of pistack.

**T3 Code.** T3 starts `pi --mode rpc` with the thread's workspace as the working directory and the same `~/.pi/agent`. It adds two `--extension` flags and no skill flags. CLI and T3 sessions in the same directory therefore load the same skills. T3's command cache `~/.t3/caches/pi.json` comes from a Pi process started in the home directory, so it never shows what loads inside a repository. The T3 launch details come from strings in the T3 binary, not from a traced launch.
