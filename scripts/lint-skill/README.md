# lint-skill

Read-only linting for Agent Skills used in Pi. Requires Node.js 22.19 or newer.
It is a repository tool, not part of any Pi package, so any package here can
lint its skills with it. It does not require a running Pi session.

## Run

Install the repository once from its root (`./scripts/ci-install.sh`, or
`npm ci --ignore-scripts`). This directory is a workspace member, so its
dependencies install with the rest and its binary is linked into the root
`node_modules/.bin`:

```sh
node scripts/lint-skill/lint-skill.mjs /path/to/my-skill
npx lint-skill /path/to/my-skill   # from the repository root
```

The examples below use the bare `lint-skill` name:

```sh
lint-skill /path/to/my-skill
lint-skill --resource-root /path/to/skills /path/to/skills/first /path/to/skills/second
lint-skill --format json --strict /path/to/my-skill
lint-skill --help
```

Arguments select directories containing exact-name `SKILL.md`, not collection
roots or standalone Markdown files. There is no implicit Pi settings discovery.
Paths supplied on the command line resolve against the current working directory.

| Exit | Meaning |
|---|---|
| 0 | Complete check with no errors; warnings allowed |
| 1 | Lint errors, or any warnings with `--strict` |
| 2 | Invalid invocation/configuration or an incomplete check |

Linting performs no network requests, model calls, script execution, or writes to
the skill. Dependency installation is separate and may require network access.

## What it checks

- Required YAML frontmatter, field types, names, directory/name agreement, and
  length limits. An invalid skill can still load in Pi; that does not make it
  valid for this authoring contract.
- Pi's boolean `disable-model-invocation` extension, Unicode/UTF-16 compatibility
  differences, and the fact that Pi does not enforce `allowed-tools` permissions.
- Empty instructions, 500-or-more-line `SKILL.md` files, and unknown fields.
- Explicit local links, unreachable files, and resources more than two hops away.

It does not grade description quality, estimate exact model token counts, require
particular headings, or prove that bundled programs work. `scripts/`, `assets/`,
and `references/` are conventions rather than mandatory directories.

YAML uses typed scalars without coercion. Duplicate keys, custom tags, and aliases
are rejected. Use string values in `metadata`; quote version numbers as needed.
Quoted `"true"` is not a valid `disable-model-invocation` boolean.

Unicode lowercase letters/numbers are accepted under the chosen interpretation
of the specification; non-ASCII names warn because Pi's native naming check uses
ASCII. Names are not silently trimmed or normalized. Standard character limits
count Unicode code points; Pi UTF-16 discrepancies are reported separately.

## Explicit references and path resolution

Use Markdown links for resources an agent needs to discover:

```markdown
For reporting tasks, read [the reporting guide](references/reporting.md).
```

**All relative resource paths resolve against the skill root**, even inside a
nested reference document. This matches Pi's instructions, not conventional
browser Markdown resolution. In `references/reporting.md`:

```markdown
Use [the template](assets/report.json).
Run [the renderer](scripts/render.py) with the selected template.
```

Both resources above are relative to the directory containing `SKILL.md`.
Backticked paths and commands do not establish reachability. They may name outputs
or examples, so lint deliberately does not infer references from them.

Inline links, reference-style links, images, and URL autolinks are recognized.
Unused reference definitions do not create routes. Links inside fenced/inline
code are examples, not references. Raw HTML attributes and arbitrary script imports
are not analyzed. Fragment-only links introduce no file; file-plus-fragment links
check the file, not whether the heading/anchor exists. URL escapes in local targets
are decoded once, and query/fragment text is not part of the filesystem filename.

A directory link does not make every descendant reachable. Each file needs a
route or a deliberate orphan exemption.

## Hops and orphans

`SKILL.md` is hop 0. Its direct resources are hop 1; resources selected by a linked
guide are hop 2. Three or more hops warn. The shortest route counts: cross-links
and backlinks do not make an otherwise shallow resource fail. Depth findings show
the route. Traversal continues beyond the warning depth to avoid confusing deep
resources with orphans.

This is a deliberate authoring policy. The [Agent Skills specification](https://agentskills.io/specification#file-references)
recommends one hop; we allow two to support task-specific guides without forcing a
flat inventory into `SKILL.md`. Static reachability proves a route exists, not
that its wording will cause an agent to choose it.

Inventory includes scripts, assets, and hidden support files. Only `.git`,
`node_modules`, `__pycache__`, and `.pytest_cache` directories are excluded by
default. Legal files and manifests are not automatically exempt. Markdown in
orphaned files is checked for broken links, but does not establish root reachability.
Disconnected cycles remain orphans.

## External resources and filesystem limits

By default the skill directory is the traversal scope. `--resource-root` allows
shared/sibling resources within a larger directory that contains all selected
skills. It does not change relative-path resolution. Shared reference documents
retain the originating skill's path base.

- External files within scope are checked; unrelated files there are not orphans.
- Another skill's `SKILL.md` is recorded as a dependency, not traversed as part of
  this skill. Select it separately to lint its own graph and hop budget.
- Outside-scope references and URLs are reported as unverified, not silently
  followed. Their presence alone does not warn, but reaching them through more
  than two hops does. Offline lint cannot prove availability or inspect later hops.
- Directory symlinks are not recursively inventoried. Explicit linked regular
  files are followed only when resolved targets remain in scope. Broken links,
  unsupported special files, and unverified scope escapes are distinguished.

Limits per skill: 1 MiB per parsed file, 32 MiB of total parsed input, 10,000
inventoried entries, 2,000 parsed documents, and 50,000 extracted links. Exceeding
a limit makes the report incomplete and exits 2; it never produces a truncated
successful check. CLI v1 does not expose limit overrides.

The command expects a stable filesystem snapshot. It is not a sandbox against
concurrent hostile filesystem mutation.

## Explicit exceptions

Pass a regular JSON file of at most 1 MiB with `--config`; no configuration is
discovered automatically:

```json
{
  "version": 1,
  "skills": [
    {
      "path": "./skills/reporting",
      "exceptions": [
        { "rule": "orphan", "path": "LICENSE", "reason": "Legal attribution" },
        {
          "rule": "depth",
          "path": "assets/rare-template.json",
          "maxDepth": 3,
          "reason": "Selected through the exceptional-report guide"
        }
      ]
    }
  ]
}
```

Skill selectors resolve relative to the config file. Exception paths are exact,
skill-local relative paths: no absolute paths, `..` segments, or glob expansion.
Reasons must be nonempty. Depth overrides must be integers from 3 through 100.
Unknown fields and duplicate selectors/exceptions are rejected. Unselected skill
entries are ignored, allowing one config to serve a collection.

Applied exceptions are reported; unused exceptions on selected skills warn as
stale. An exception does not create a graph edge and cannot suppress broken links,
specification errors, or traversal safeguards.

## Output and tests

Text output includes rule IDs, severities, source locations when available, and
incomplete-check status. JSON stdout is a versioned envelope with `complete`,
`results`, error/warning `counts`, and invocation/configuration `errors`. Each
skill result contains findings, external dependencies with verification status,
and applied exceptions. Paths are absolute; output ordering is deterministic.

Run `npm test` in this directory for the fixture and CLI tests; the root
`./scripts/check.sh` runs them before any package check. Packages call the CLI
from their own `check` script with explicit skill directories and their
`skills/` directory as the resource root (see
`packages/pi-pocock-skills/scripts/check-skills.mjs` and
`packages/p3stack/generator/lint-skills.mjs`). Warnings remain visible; strict
mode is opt-in.
