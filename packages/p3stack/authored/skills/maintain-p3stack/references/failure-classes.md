# Failure classes

Use the named diagnostic to find the input owner. Read the upstream diff before a repair. Keep generated `skills/` and `agents/` unchanged by hand. Never edit files under `vendor/`. Repair vendored prose through generator inputs.

| Diagnostic | Fix location and action |
| --- | --- |
| `Unclassified skill`, `Stale registry row`, or `Missing authored skill` | Classify each new upstream path in `registry/skills.json` with an emit or drop reason. Update renamed or removed paths and their consumers. Restore a missing owned skill in `authored/`, or remove its row and routes together. |
| Duplicate row or emitted name, invalid action, name, or invocation, or missing reason, phases, or roles | Repair `registry/skills.json`. Keep one row per source path and one owner per emitted name. |
| `Authored skill ... must emit at`, different frontmatter name or invocation | Align the owned file in `authored/` with `registry/skills.json`. For vendored files, correct the registry and the scoped rename rule in `rules/tokens.json`. |
| `Missing emitted skill`, `Unregistered emitted skill`, or `Registry skill ... is not mapped` | Align `registry/skills.json` with maps in `rules/manifest.json`. Register new owned inputs in `authored/`. Check whether an `extra/` file unintentionally creates a second skill. |
| `token rule <id>: ... matches, expected at least <min>` | Review the new upstream sentence and prior rewrites. Update the scoped `find` in `rules/tokens.json`, or remove a rule whose translation is no longer needed. Preserve its Pi behavior elsewhere if still required. Do not lower `min` to hide a missed match. Record the old and new match in the bump note. |
| Unknown token source, missing upstream checkout for a commit placeholder, or invalid regular expression | Correct the source, scope, expression, or upstream declaration in `rules/tokens.json` or `rules/manifest.json`. |
| Section `changed upstream` with old and new hashes | Compare the untranslated section at both pins. Review its corresponding file in `overlays/`. Update the overlay and only then accept the printed hash in `rules/sections.json`. Attach the section diff to the bump note. |
| Section heading missing or repeated, section not an emitted text file, or section `is not a leaf` | Correct the file and heading in `rules/sections.json`. Split parent overlays into leaf replacements in `overlays/`. Put preamble text in a heading-scoped token in `rules/tokens.json`. Do not accept a hash to conceal new child sections. |
| `patch ... no longer applies` | Rebuild the patch in `patches/` against the candidate's translated output. Prefer a token or leaf overlay if it can express the change. |
| Coupling lint with `file:line: token` or a lost dependency link | Repair `rules/tokens.json`, `rules/sections.json`, or `patches/` for vendored text. Repair `extra/` or `authored/` for owned text. Keep dependency requirements in `rules/lint.json`. Do not remove a deny token to make a bump pass. |
| `lint-skill` `references/missing` after an upstream deletion | Repair the dangling cross-skill link through a scoped token in `rules/tokens.json` or a patch in `patches/` on the referencing skill. Replace the link and its description with a deliberate surviving target, or drop the referencing skill in `registry/skills.json` with a reason. Repair owned references in `authored/` or `extra/`. Regenerate and rerun lint. Never edit the referencing file under `vendor/` or `skills/`. |
| Host lint outside the host map | Move host-specific tool details into `extra/skills/poteto-mode/references/host-capabilities.md`. Point the originating rule, overlay, extra file, or authored file at that map. |
| Route missing target, chain missing skill, invalid playbook or position, or chain anchor count other than one | Repair `registry/routes.json` and `registry/chains.json`. Restore or deliberately replace the target through `registry/skills.json`, `rules/`, `overlays/`, or `authored/`. Keep each anchor exact and unique. When removing or re-routing a target, update `packages/p3stack/test/routing-eval/prompts.json`, any fixture or assertion naming that target in `packages/p3stack/test/generate.test.mjs`, `packages/p3stack/test/extension.test.ts`, or another test, and the emitted-count assertion in `packages/p3stack/test/check-registry.test.mjs`. Regenerate and run the routing eval. Before `gh pr create`, `npm test` in `packages/p3stack` must exit 0. After any JSON edit, rerun it. |
| `sources ... both emit this path` | Resolve the ownership collision in `registry/skills.json` and the path maps or resource exclusions in `rules/manifest.json`. Use a scoped rename in `rules/tokens.json` when the emitted name changes. Never delete the generated collision by hand. |
| Upstream symlink unsupported or required upstream file missing | Review the removed or linked resource. Correct the map, exclusion, or required path in `rules/manifest.json`. Add a safe owned replacement in `extra/` only after reviewing its purpose. |
| Dirty inputs, checkout `has local changes`, or a dirty precondition | Stop without discarding anything. Ask the change owner to commit or preserve changes separately. Inspect edits to `registry/`, `rules/`, `overlays/`, `patches/`, `extra/`, and `authored/` before a retry. Resume in a clean worktree. |
| Generated file missing, differs, not generated, symlink, or mode differs | Correct the owning rule or file in `extra/` or `authored/`, then regenerate. A clean second generation must reproduce the intended diff. |
| Checkout pin differs from gitlink or `package.json` upstream differs | After a bump and before staging, gitlink drift is expected, not a blocker. Run `git add packages/p3stack/vendor/pstack` for the shared Cursor checkout or `git add packages/p3stack/vendor/matt-pocock` for Pocock from the root before any pin check. Confirm the candidate in `rules/manifest.json` and regenerate its metadata. Keep sources that share a checkout at one SHA. Do not change the manifest's source identity to hide pin drift. |
| README pin markers missing or stale | Restore exactly one marker pair in the package README if needed. Confirm `rules/manifest.json`, then regenerate to refresh all source pins. The README is metadata, not a generated skill repair. |
| Empty resource check, staged lint failure, or missing resource linter | Inspect `rules/manifest.json` and `rules/lint.json`, then fix links in the owning rule, `extra/`, or `authored/`. Run from the installed repository workspace so its linter exists. Do not disable resource validation. |
| Output replacement fails, with recovery copies retained | Stop and preserve the printed backup path. Inspect filesystem permissions and recover the prior output before retrying. This is not a prose-rule fix. Do not delete the only recovery copy. |
| Contract, diagnostic state, or doctor JSON `<path> could not be read` | Correct the supplied input path, permissions, or malformed JSON fixture. Restore valid `rules/t3-pin.json` when it is the failing input. Retry the checker. Keep unreadable inputs visible rather than changing the contract to hide them. |
| Invalid contract JSON, unsupported prompt return contract, or host map missing a required direct tool | Repair `rules/t3-pin.json`, `extra/skills/poteto-mode/references/host-capabilities.md`, or the checker in a separate host-contract PR with hermetic fixture tests. Preserve required behavior and regenerate derived skills. |
| Installed release or bridge hash differs from historical provenance | Record optional diagnostics through the host map. Equality is not required and a difference alone needs no repair. Verify required capabilities and behavior instead. Keep the installed host and recorded fingerprints unchanged. |
| Doctor missing a required tool or direct exposure, reported problems, or incompatible live arguments, return shape, or behavior | Stop source maintenance. Preserve the live doctor dump and catalog or behavioral evidence. Repair the owning host contract separately, with fixture tests and live verification. Doctor inventories tools but does not prove schemas or behavior. If required behavior cannot be preserved and verified, report the exact command, exit code, and complete output as `BLOCKED`. |
| Lockfile or installed dependency mismatch | Dispatch the separate procedure in the repository root's `docs/dependency-refresh-2026-10-18.md`. Preserve this skill's no-install and no-merge bounds. Do not mix lockfile refreshes into a source PR. |

Unknown sources, missing checkouts, bad refs, and fetch failures stop before a rule repair. Read `rules/manifest.json` and the package `AGENTS.md` to correct the request or checkout setup. Usage errors require the supported command syntax, not a new bypass.

## Classify an upstream skill

Add one of these rows to `packages/p3stack/registry/skills.json`. Replace every placeholder with the observed source, source-relative skill path, and reviewed decision. Use the existing registry's phase and role vocabulary for an emit row. Do not copy both rows for one path.

```json
{
  "source": "<source>",
  "path": "<path>/SKILL.md",
  "action": "emit",
  "name": "<emitted-name>",
  "invocation": "model",
  "phases": ["<phase>"],
  "roles": ["<role>"],
  "reason": "<why this skill belongs in p3stack>"
}
```

```json
{
  "source": "<source>",
  "path": "<path>/SKILL.md",
  "action": "drop",
  "reason": "<why this skill is excluded>"
}
```

Run `node packages/p3stack/generator/check-registry.mjs` from the root. Classification is complete only when every new path has one row and the result reports `0 unclassified`.
