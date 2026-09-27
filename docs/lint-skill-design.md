# `lint-skill` v1 design

Status: implemented v1 contract. The user approved implementation after the
product decisions below. The final defaults in the next section resolve the
remaining implementation choices.
Evidence and alternatives: [research notes](lint-skill-research.md).

## Frozen implementation details

- Public seams under test: `lintSkill(directory, options)` and the executable CLI,
  including packed-package invocation. Use real temporary directory fixtures.
- ESM entry `scripts/lint-skill.mjs`; core export in `lib/lint-skill.mjs`.
- Parsers: `yaml` 2.9.1 and `mdast-util-from-markdown` 2.0.3, exact runtime dependencies.
- Default limits per skill: 1 MiB per parsed file, 32 MiB total parsed bytes,
  10,000 inventoried entries, 2,000 parsed documents, and 50,000 extracted links.
  Exceeding any limit makes the report incomplete. The module accepts lower test
  limits via `options.limits`; CLI v1 exposes no limit overrides.
- `lintSkill` is synchronous and returns
  `{schemaVersion: 1, skill: absolutePath, name: string|null, complete: boolean,
  findings: [], dependencies: [], appliedExceptions: []}`. Options are
  `{resourceRoot?, exceptions?, limits?}`; defaults allow standalone invocation.
- Findings use `{ruleId, category, severity, path, message, line?, column?,
  route?, depth?, allowedDepth?}`. Categories are `specification`, `pi`, `authoring`,
  or `operational`; severities are `error` or `warning`. File paths are absolute;
  routes may end in a terminal URI. An operational failure returns an incomplete
  report, not a throw.
- Dependencies use `{from, target, kind, status}`; kinds are `url`, `external`,
  `skill`, `directory`, or `symlink-directory`; statuses are `exists` or
  `unverified`. The report records links from orphan documents too, without
  treating those references as root-reachable routes.
- CLI JSON is `{schemaVersion: 1, complete, results: [skillReport...],
  counts: {error, warning}, errors: [message...]}`. `errors` contains invocation
  or configuration failures; per-skill failures are findings. Invalid invocation
  still emits this envelope when `--format json` was successfully requested.
- Explicit config schema:
  `{version: 1, skills: [{path: "./skills/example", exceptions: [
  {rule: "orphan", path: "LICENSE", reason: "Legal attribution"},
  {rule: "depth", path: "assets/template.json", maxDepth: 3,
   reason: "Selected through a task-specific guide"}]}]}`.
  Reject unknown keys, duplicate skill/rule-path entries, empty reasons, absolute
  exception paths, `..` segments, and maxDepth values other than integers 3–100.
  Skill selectors resolve from the config file; exceptions select local files
  only. No implicit config discovery. Config entries for unselected skills are
  ignored so one config can serve a package. A selected skill's unused exceptions
  warn as stale; applied exceptions echo their configured rule/path/reason.
- Limit keys are `fileBytes`, `totalBytes`, `entries`, `documents`, and `edges`.
  Each override must be a positive safe integer.
- Broken references use `references/missing`; orphan and depth findings use
  `resources/orphan` and `resources/depth`; stale exceptions use `config/stale`.
  Remaining stable rule IDs are documented with the implementation.
- Unicode naming uses Unicode letters/numbers plus hyphens and equality with its
  lowercase spelling; Pi's ASCII-only restriction remains a separate warning.
- The exact exclusion list is `.git`, `node_modules`, `__pycache__`, and
  `.pytest_cache` directories (including symlinked directory entries). Exclusions
  affect inventory, not whether an explicit link may be checked.
- Inputs are treated as a stable filesystem snapshot, not hostile concurrent
  mutation. Check regular-file types and traversal scope before reading; do not
  claim the CLI is a filesystem sandbox.

## Agreed product behavior

Ship a JavaScript command with `agent-skills` for linting Agent Skills used in Pi.
It accepts explicitly supplied skill directories, including directories outside
this repository. It is not a Pi extension and needs no Pi runtime.

Validate portable authoring requirements while recognizing Pi's extensions and
limitations. Do not equate “Pi will load this” with “valid skill.” Identify findings
as specification, Pi compatibility, or local authoring policy.

Reference analysis:

- Explicit Markdown links establish reachability. Commands and bare/backticked
  paths do not. This is an authoring requirement, not prose inference.
- Resolve relative resource paths against the skill root, including references in
  nested documents. Never try document-relative fallback resolution.
- Start at `SKILL.md` (depth 0). Use shortest routes. Two hops are accepted by
  default; warn at three or more. Folder nesting is not reference depth.
- Detect orphaned skill-local files independently of hop counts. Do not require
  every resource to be linked directly from `SKILL.md`.
- Support deliberate scoped exceptions rather than meaningless shortcut links.
- Follow local references only within the skill or an explicitly supplied resource
  root. Report outside-root dependencies as unverified.
- A reference to another skill's `SKILL.md` records a separately lintable skill
  dependency with its own root and hop budget. Do not flatten that skill's graph.
- Record web URLs without fetching. A link is not verification of availability.

The spec recommends one hop. Our two-hop budget is a deliberate local policy,
not a claim about specification conformance or proven optimal agent behavior.

## CLI and distribution

```text
lint-skill <directory>... [--resource-root <directory>]
                        [--config <file>] [--format text|json] [--strict]
```

- Explicit directories only, each requiring exact-name `SKILL.md`. No automatic
  Pi settings discovery, standalone Markdown input, or recursive skill discovery.
- A resource root grants traversal scope, not a different relative-path base.
  It must contain the supplied skills. Without it, each skill is its own scope.
- Text output by default. JSON is one versioned report on stdout; operational
  messages go to stderr. Diagnostics sort deterministically by input skill, file,
  location, and rule ID. Deduplicate repeated skill arguments.
- Exit 0: completed without errors; warnings allowed. Exit 1: lint errors, or
  warnings with `--strict`. Exit 2: invalid invocation/configuration or an
  incomplete check. A missing `SKILL.md` in an existing directory is a lint error.
- Missing/unreadable command-line roots are operational failures. Missing linked
  files are lint errors; inaccessible files make analysis incomplete, not clean.
- Read-only and noninteractive. No autofix, script execution, model calls, or
  network access during linting. Installing dependencies is a separate operation.

Use Node >=22.19, ESM, a `bin` entry pointing to `scripts/lint-skill.mjs`, and an
explicit published-file list containing the CLI and its implementation. Declare
parser libraries as runtime dependencies and commit the package lockfile.

Document direct invocation (`node /path/to/agent-skills/scripts/lint-skill.mjs ...`)
and npm binary usage. Do not promise that Pi package installation adds the command
to the user's shell PATH. Test the packed package, not only a working checkout.

## Module and parsing

One deep module exposes:

```text
lintSkill(directory, options) -> report
```

It owns inventory, parsing, graph analysis, and findings. The CLI is a thin adapter
for arguments, multiple inputs, rendering, and exit status. Keep parsers and graph
algorithms private; no plugin framework or abstraction solely for a future port.

Use `yaml` and `mdast-util-from-markdown` with locked dependency versions.
The AST must distinguish actual links/images from fenced and inline code examples,
and support reference-style links and source positions.

### Frontmatter

- Accept UTF-8 BOM and normalize CRLF/CR for parsing and line counting.
- Require standalone opening and closing `---` lines and one YAML mapping.
- Reject duplicate keys, custom tags, and aliases in v1. Do not enable merge-key
  behavior. These restrictions are local authoring policy where YAML permits more.
- Preserve typed scalars; do not coerce values to satisfy the field schema.
- Required string `name`: 1–64 Unicode code points, lowercase letters/numbers and
  hyphens, no leading/trailing/consecutive hyphens, exact parent-directory match.
  Do not silently trim or normalize it. Emit a separate Pi portability warning
  for non-ASCII names; the specification's Unicode wording is ambiguous.
- Required string `description`: non-whitespace, at most 1024 code points.
- Optional string `compatibility`: non-whitespace, at most 500 code points.
- Optional `metadata`: mapping with string keys and string values.
- Optional `license` and `allowed-tools`: strings. Do not infer a file reference
  from arbitrary license prose. Warn that Pi does not enforce `allowed-tools`.
- Optional Pi `disable-model-invocation`: boolean, not the string `"true"`.
- Unknown fields warn, with guidance to use `metadata` for custom information.
- Report Pi's UTF-16 length discrepancy separately when it changes a limit result.

Warnings for an empty body and a whole `SKILL.md` of 500 or more lines. A terminal
newline does not add an extra empty line. No exact token-count rule or semantic
judgment of description quality. Do not require particular headings or English
trigger phrases.

### Link extraction

- Inline links, resolved reference-style links, and images contribute edges.
  Count destinations, not unused reference definitions. URL autolinks are external
  references; raw HTML attributes are outside v1's extraction contract.
- Do not inspect code blocks or inline-code contents for links or dependencies.
- Fragment-only destinations refer to the containing document, introduce no new
  file, and do not change reachability. For a file plus fragment, check the file;
  heading/anchor validation is out of scope for v1.
- Parse destinations before path resolution: distinguish URI schemes from local
  paths, decode local URL escapes once, and diagnose invalid encoding. Do not
  interpret query/fragment text as part of a filesystem filename.
- Record non-file URI schemes without executing handlers or fetching content.
  Absolute/file-URI local paths require the same traversal-scope checks and should
  warn as nonportable. No shell or environment-variable expansion.
- Directory links may be checked for existence but do not make all descendants
  reachable. A file needs its own explicit route or exemption.

## Graph and filesystem

Inventory files separately from following references. Parse skill-local Markdown
for broken links even if orphaned; only root-reachable documents establish routes.
Suppress orphan/depth conclusions when the entry document cannot be parsed, rather
than reporting every resource as an orphan after one frontmatter failure.

Use a breadth-first traversal from `SKILL.md`, retaining a predecessor chain for
explanations. Continue beyond the warning threshold to distinguish deep resources
from orphans. Track visited documents so backlinks and cycles terminate normally.

An external shared document retains the originating skill's relative-path base.
Only separately linting another skill starts a new base and hop budget. Report
this behavior explicitly: shared documents cannot silently opt into conventional
Markdown path resolution. External files are not included in the orphan inventory.

Symlink policy:

- Resolve the supplied skill root once for traversal safety, while comparing its
  declared name to the supplied directory basename.
- Check both lexical paths and resolved targets against the allowed scope.
- Do not recursively inventory symlinked directories; report them as unexpanded
  resources. Follow explicitly linked regular files only when their resolved
  targets are in scope, using canonical identity to avoid repeated parsing.
- Report broken links and scope escapes distinctly. Out-of-scope resources remain
  unverified, not missing. Never treat an unverified resource as fully checked.
- Never read special files such as FIFOs or devices. Return an unsupported-resource
  diagnostic instead.

The finite budgets in the frozen details above cover file bytes, total bytes,
inventoried entries, parsed documents, and links. Exceeding a budget produces an
incomplete report and exit 2, not a successful truncated analysis. Configuration
files are also restricted to regular files no larger than 1 MiB.

## Orphan exemptions and configuration

Inventory scripts, assets, reference documents, and hidden support files. Exclude
only a documented narrow list of VCS/dependency/cache directories by default:
`.git`, `node_modules`, `__pycache__`, and `.pytest_cache`. Do not
blanket-exclude dotfiles, legal files, or manifests.

Use an optional explicit JSON configuration file, not automatic discovery or
cascading configuration. Configuration supports exact per-skill file
exceptions with a required reason:

- Exempt a file from orphan reporting.
- Permit a larger depth for a particular resource.

Resolve skill selectors relative to the config file and resource paths relative
to the selected skill. Do not allow configuration to suppress specification errors,
broken references, or traversal safeguards. Exceptions do not create graph edges.
Report applied exceptions and warn on stale entries so missing files or changed
routes cannot silently leave obsolete exemptions behind. No arbitrary rule
plugins or broad ignore globs in v1. The JSON shape is frozen above.

## Report and diagnostic contract

Reports contain `schemaVersion`, completion state, skill identity, findings,
external dependencies and their verification status, and applied exceptions.

Each finding has a stable rule ID, authority/category, severity, path, optional
1-based line/column, and actionable message. Depth findings also include the
shortest route and observed/allowed depth. Orphans name the unreachable file.

- Errors: invalid frontmatter/schema, required file missing, broken local targets.
- Warnings: excessive depth, orphans, unknown fields, portability/Pi limitations,
  excessive line count, empty body, stale exceptions.
- Unverified external references are explicit report entries. Their mere presence
  does not warn, but the hop budget still applies to routes to external resources,
  including terminal URLs. No claim is made about further hops beyond those URLs.
- Suppress dependent diagnostics after primary parse failures.

Text and JSON must agree on counts and exit results. Non-content failures must
never be represented as a complete clean lint pass.

## Implementation and acceptance sequence

1. Freeze CLI/config/report shapes and remaining resource-budget defaults.
2. Write fixture expectations and CLI tests with Node's test runner.
3. Implement frontmatter checks, then extraction and reference graph analysis.
4. Exercise the tool against the existing generated skills and review findings.
5. Translate necessary references into Markdown links in `scripts/sync.sh`; never
   hand-edit generated `skills/`. Any exceptions require deliberate justification.
6. Add package lint/test checks, retaining generated-output drift validation as a
   separate concern. Root `./scripts/check.sh` delegates to package scripts.
7. Check npm tarball contents and execute the CLI from a clean installed fixture.
8. Run the canonical repository check. Introduce strict CI only after existing
   warnings have been reviewed, not by blanket suppression.

Fixtures must cover limits and +/-1, type errors, duplicate keys, BOM/newlines,
Unicode, boolean versus quoted boolean, malformed/missing files, nested-root path
resolution, inline/reference/image links, code examples, fragments/encoding,
orphaned cycles, multiple routes, depth 1/2/3, shared resources, other skills,
unverified URLs/outside-root files, symlinks/special files, scoped exceptions,
resource limits, deterministic reports, exit statuses, and packed-package usage.

Adding dependencies also requires adjusting `test-sync.sh` fixture copying: it
currently copies the entire package and would duplicate `node_modules/` into every
case. Keep fixtures focused on sync inputs, not installed dependencies.
