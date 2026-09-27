# `lint-skill`: research and design choices

Status: research history. V1 is implemented in `packages/agent-skills`.
See [the v1 design](lint-skill-design.md) for the consolidated contract and the
[command guide](../packages/agent-skills/docs/lint-skill.md) for usage. Earlier
alternatives below remain as research history, not current implementation choices.

## Confirmed scope after discussion

- V1 will use JavaScript. ESM fits the existing package; a future Python port remains
  possible if needed, but no dual implementation or porting scaffolding is planned.
- Portable authoring requirements with explicit Pi awareness, not merely “Pi loads it”.
- Focus on Agent Skills **used in Pi**. A separate generic-spec target is not needed
  for the current scope; the earlier `--target spec|pi` proposal below is superseded.
- File-reference checks belong in v1. Explicit Markdown links are the authoritative
  graph edges; bare/backticked paths and commands do not establish reachability.
  This is an authoring requirement, not a heuristic inference of agent behavior.
- Resolve relative resource paths against the skill root, including links found in
  nested reference documents. No document-relative fallback or guessing.
- Check discoverability and orphans independently of navigation depth. Accept two
  hops from `SKILL.md` by default; warn at three or more, using shortest routes.
  This is our authoring policy, deliberately more flexible than the spec's
  one-hop recommendation. Include outgoing external references in the analysis.
- External-resource checking is offline-first and bounded: follow local Markdown
  within the skill or an explicitly supplied resource root; report outside-root
  dependencies as unverified. Record URLs without fetching. Treat other skills
  as separately lintable dependencies with their own roots and hop budgets.
- Ship a standalone `lint-skill` command with `agent-skills`, usable on explicitly
  supplied skill directories outside this repository. No Pi runtime dependency.

## File-hop and orphan policy

The [specification's file-reference guidance](https://agentskills.io/specification#file-references)
explicitly says: “Keep file references one level deep from `SKILL.md`. Avoid deeply
nested reference chains.” This is an authoring recommendation, not a mandatory
schema constraint. Neither the inspected reference validator nor Pi's loader
builds a reference graph or diagnoses orphaned resources.

Agreed reachability/depth model; remaining diagnostic defaults are proposed:

- Start at `SKILL.md` (hop 0); explicit references create directed edges to resources.
- A file directly referenced by `SKILL.md` is hop 1, regardless of folder nesting.
- Use the shortest discoverable route from the root. Extra cross-links or backlinks
  should not make an otherwise directly reachable file fail a depth check.
- Prefer one hop for core or frequently used resources; accept two hops by default
  for organized supporting material. Warn when a resource's minimum depth exceeds
  2. Show the shortest chain, and permit deliberate scoped exceptions (mechanism
  undecided). Do not encourage meaningless shortcut links merely to silence lint.
- Two hops is a pragmatic local policy, not a specification requirement or an
  empirically established optimum. A guide can route to task-specific scripts,
  assets, or references without listing every resource in `SKILL.md`.
- Static reachability proves that a route exists, not that its wording enables an
  agent to choose it correctly. Discoverability does not require eager loading.
- Inventory skill-local files independently of graph traversal. Warn for any
  non-exempt file unreachable from the root; disconnected cycles are still orphans.
- Broken explicit local references are errors under our authoring policy, not
  necessarily a Pi load failure. Depth and orphan findings are warnings promotable
  to failures by strict mode.
- A cycle is not automatically a problem: supporting docs may link back to the
  root. Traversal must terminate, but warning on every cycle would be noisy.

Agreed reference syntax and remaining choices:

1. **What counts as an edge? Agreed:** explicit Markdown links are authoritative.
   Bare/backticked paths and commands do not establish reachability: they may be
   inputs, outputs, examples, or dynamically generated paths. No path heuristics
   in v1. Existing generated references that rely on those forms will need to be
   translated into links through `scripts/sync.sh`, not edited in `skills/`.
2. **Which files count?** Include scripts, assets, and hidden support files by
   default, not only Markdown. Exclude known VCS/install/cache artifacts and allow
   narrow documented exemptions. Do not blanket-exempt dotfiles. Legal/package
   bookkeeping files may merit explicit exemptions. A directory link alone must
   not silently mark every descendant reachable.
3. **Runtime dependencies versus documentation references.** Do not infer arbitrary
   imports or script-loaded assets. They need explicit discoverability pointers or
   a deliberate exemption. A link is a static route, not proof an agent will follow
   it or that the resource will work.
4. **External local resources. Agreed:** check local targets and follow Markdown
   within the skill or an explicitly supplied resource root (for example the
   package's `skills/` directory). Outside that scope, report an unverified external
   dependency rather than traversing it. Only inventory the skill directory for
   orphans, not unrelated files in dependency directories. Broken, cyclic, and
   escaping symlinks need bounded handling; exact mechanics remain to be designed.
5. **Other skills. Agreed:** record a sibling `SKILL.md` as a skill dependency and
   lint it separately with its own root and hop budget. Do not flatten its graph
   into the caller's depth budget. Ordinary external documents do not reset hops.
6. **URLs. Agreed:** record terminal external references without fetching or web
   crawling. Include the hop to the link, but distinguish linked resources from
   resources verified available. Offline lint cannot inspect further remote hops.
7. **Path base. Agreed:** resolve relative resource paths against the skill root,
   including links in nested reference documents, matching Pi's instructions.
   Never fall back to the containing document's directory or try both bases.
   Document this departure from conventional Markdown link resolution. External
   resource ownership and transitions into a sibling skill still need explicit
   traversal rules; they must not silently change this base.

This replaces the earlier suggestion to defer references or inspect only the root
file. A recursive local Markdown graph is needed for the requested hop/orphan
analysis, with explicit treatment of terminal resources and traversal scope.

## Sources and scope

Read the live [Agent Skills specification](https://agentskills.io/specification),
[creator best practices](https://agentskills.io/skill-creation/best-practices), and
[script guidance](https://agentskills.io/skill-creation/using-scripts).
The specification matched the source at upstream commit
[`69ef37e9424c0a7ea9dd2293b559e43ec8176379`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx).
This is an evidence snapshot, not a numbered specification release.

Reference implementation inspected at the same commit:

- [validator.py](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/validator.py)
- [parser.py](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/parser.py)

Pi evidence:

- [0.87.1 skills documentation](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/skills.md)
- [0.87.1 loader](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/skills.ts): `loadSkillFromFile`, `validateName`, `validateDescription`, `formatSkillsForPrompt`, discovery functions.
- [0.87.1 YAML/frontmatter parser](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/utils/frontmatter.ts).
- [0.85.1 loader](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/skills.ts) and [parser](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/utils/frontmatter.ts): these two source files are identical to their 0.87.1 counterparts.

The installed Pi 0.87.1 skills/settings/packages docs and SDK skills example were
also read. This investigation uses source inspection, not an end-to-end runtime
conformance test. The linter must not claim to validate the entire Pi environment.

## What the specification actually requires

- A directory containing exact-name `SKILL.md`, with YAML frontmatter and Markdown.
- `name`: required, 1–64 characters, lowercase alphanumeric/hyphen, no leading,
  trailing, or consecutive hyphens; must match its parent directory name.
- `description`: required, nonempty, 1–1024 characters.
- Optional `compatibility`: 1–500 characters if present.
- Optional `metadata`: mapping of string keys to string values.
- Optional `license`: license name or reference to a bundled license file.
- Optional `allowed-tools`: space-separated string; explicitly experimental and
  implementation-dependent.

Do not promote recommendations into specification errors:

- Under 500 lines for `SKILL.md`; under 5000 tokens for instructions is recommended.
- Useful routing descriptions, examples, steps, edge cases, concise references,
  dependency documentation, and helpful script errors are authoring guidance.
- `scripts/`, `references/`, and `assets/` are conventions, not mandatory folders;
  arbitrary additional files/directories are expressly allowed.
- “One level deep” concerns reference chains, not a prohibition on nested folders.
- The prose asks for Markdown instructions, but its minimal example has no body.
  An empty-body warning is defensible; a hard error needs an explicit local policy.

## Specification, reference validator, and Pi are different contracts

| Case | Specification / reference validator | Pi 0.85.1 and 0.87.1 loader |
|---|---|---|
| Missing name | Spec requires it; reference validator rejects | Falls back to directory name, including non-string/empty declared name |
| Name differs from directory | Spec requires a match | Accepted without a mismatch warning |
| Invalid name / overlong name | Invalid under naming rules | Warns but loads if description is usable |
| Missing, whitespace-only, non-string description | Invalid | Does not load |
| Description over 1024 | Invalid | Warns but loads |
| Unicode name | Spec ambiguously says “unicode” alongside `a-z`, `0-9`; reference validator supports Unicode alphanumerics and NFKC normalization | ASCII regex warning, but still loads |
| `disable-model-invocation` | Absent from spec's field list; reference validator rejects it as unexpected | Only literal YAML boolean `true` hides skill from automatic prompt advertisement |
| `allowed-tools` | Experimental standard field | Not consumed as tool permission configuration by the skill loader |
| Other optional fields | Defined by spec | Not validated or retained in the loader's `Skill` object |
| Unknown top-level field | Spec lists fields but does not explicitly state an unknown-field rejection rule; reference validator rejects | Ignored |
| Standalone Markdown | Not portable directory form | Supported for explicit paths and direct Markdown children of scanned roots |

Ignoring a field in the loader does not mean the model can never read it: automatic
loading reads the file. Conversely, putting a permission claim in frontmatter does
not grant or restrict native tool access.

The reference validator is useful evidence, not an exact executable specification:

- Accepts lowercase `skill.md` as well as `SKILL.md`.
- Strips and NFKC-normalizes names before validating/matching.
- Allows empty `compatibility` despite the prose's minimum of one character.
- Does not fully validate `license`, `allowed-tools`, or nested `metadata` types.
- Uses StrictYAML; Pi uses the JavaScript `yaml` package. Their accepted YAML and
  scalar typing differ.

Therefore, simply wrapping `skills-ref validate` would both reject our legitimate
Pi extension and miss useful checks. Importing Pi's loader would inherit its
intentional permissiveness and would not provide specification conformance.

## Decisions needed

### 1. What does a successful lint promise?

Options:

1. **Portable authoring rules with Pi awareness (recommended).** Standard required
   fields remain required even where Pi supplies defaults. Pi behavior is reported
   separately. Accept the documented Pi boolean extension when targeting Pi.
2. **Loads in Pi.** Weaker: invalid names and excessive descriptions can still load;
   little improvement over native startup diagnostics.
3. **Exact reference-validator parity.** Includes its quirks and rejects our current
   `disable-model-invocation` skills; not recommended.

Do not call Pi's documented extension “part of the specification.” Diagnostics
should identify their authority: specification, Pi compatibility, or authoring
recommendation. A Pi target must not silently erase specification violations.

### 2. Deterministic best practices or semantic review?

Recommend deterministic checks only in v1:

- Errors for missing `SKILL.md`, invalid frontmatter, missing/invalid required
  fields, standard length/shape violations, and malformed optional fields.
- Warnings for excessive line count, empty body, unknown fields, and Pi-ignored
  `allowed-tools`. Unknown-field warning wording should distinguish a possible
  typo from a deliberate extension.
- Validate `disable-model-invocation` as boolean for a Pi target; quoted `"true"`
  is a particularly useful error because it does not disable automatic selection.
- Do not require English phrases such as “Use when”, a minimum description word
  count, particular headings, examples, or specific directory names.
- Do not present a character/4 estimate as an exact 5000-token check. Defer token
  linting unless a tokenizer/estimation policy is chosen explicitly.
- Never execute bundled scripts or call models/network services during linting.

Routing quality and script robustness require human review or behavioral evals,
not a claim that static lint has proved them.

### 3. YAML and Unicode policy

Use a real YAML parser; require a top-level mapping and reject duplicate keys.
Accept BOM and CRLF, but require standalone opening/closing frontmatter delimiter
lines rather than copying Pi's permissive delimiter detection.

Need explicit decisions on scalar typing, aliases/merge keys/custom tags, maximum
input size, and character counting. Suggested baseline: YAML 1.2 ordinary typed
scalars, no coercion into expected field types, code-point lengths for spec checks,
and separately label any Pi UTF-16-length discrepancies. Do not silently trim or
normalize malformed names to make them pass.

ASCII names are the safest cross-Pi convention, but an ASCII-only error should be
labelled a chosen portability policy, not an unambiguous reading of the Unicode
wording. Alternatives: accept Unicode with an ASCII portability warning, or
explicitly choose the stricter ASCII subset. This remains open.

### 4. One directory or a package of interdependent skills?

Our generated tree intentionally contains:

- `../grilling/SKILL.md` and other sibling dependencies;
- `../references/CHILD-DELEGATION.md` shared by several skills;
- output/project paths such as `CONTEXT.md` and `docs/adr/` that need not already
  exist in the skill directory;
- Markdown examples containing links that are illustrative, not actual resources.

Consequences:

- Do not treat every backticked path as an existing bundled file.
- Do not blanket-reject `../` as a specification violation.
- Do not assume every child of `skills/` is itself a skill (`references/` is not).
- If link checks are included, initially inspect real Markdown link/image targets
  in `SKILL.md`, excluding code examples, URLs, and fragment-only links. Handle
  reference-style links and percent-encoding with a Markdown parser, not regexes.
- Warn for missing local targets; distinguish outside-skill dependencies from
  missing files. An explicit package root could authorize sibling dependencies.
- Do not recursively read outside an authorized root, follow symlink cycles, or
  fetch remote links. Existence is not evidence a resource is safe.
- Checking bare/backticked script/skill paths needs an additional convention or
  heuristic. Recommend deferring this instead of promising complete dependency
  checking in v1.

Recommend explicit skill-directory arguments in v1, possibly multiple, without
Pi's automatic discovery. Collection discovery, collision checks, and package-root
reference checking are a separate scope decision. Global name collisions cannot
be ruled out by examining one directory.

### 5. Runtime and distribution

**Decision: JavaScript for v1.** A Python port can be considered if a concrete need
arises. Keep behavior documented through CLI/diagnostic contracts and fixtures,
without introducing abstractions solely for a hypothetical port. Parser choices
below remain recommendations.

Alternatives considered:

| Choice | Trade-off |
|---|---|
| JavaScript ESM + `yaml` (recommended) | Existing Node >=22.19 CI/runtime; no build or TS runner; proper parser; adds package dependency and lockfile |
| TypeScript + `yaml` | Consistent with extension packages; adds compiler/runner or build setup for a small CLI |
| Python + YAML library | Good filesystem tooling; `skills-ref` ecosystem, but adds Python dependency/install contract and still needs custom rules |
| Bash | Fits current sync scripts, but inappropriate for reliably parsing YAML/Markdown; delegating parsing adds another runtime anyway |

Use an explicit dependency, not another package's transitive `yaml` install.
A real Markdown parser is also needed for the agreed reference-graph checks;
its specific library remains to be chosen.

**Decision: ship the standalone command with `agent-skills`.** The current manifest
excludes `scripts/` from published files. Add `bin`, the implementation files, and
runtime dependencies to the package contract. Document direct Node invocation as
well as npm binary usage: installing a Pi package does not necessarily expose its
binary on the user's shell PATH.

## Tentative small design

Subject to the decisions above:

```text
lint-skill <directory>... [--target spec|pi] [--format text|json] [--strict]
```

- One deep module: `lintSkill(directory, options) -> report`; filesystem reading,
  YAML parsing, and deterministic rule evaluation behind that interface.
- Thin CLI adapter formats results and chooses exit status; no plugin system,
  cascading config, autofix, or Pi runtime dependency for v1.
- Stable rule IDs, category, severity, path, optional 1-based line/column, actionable
  message. Deterministic order. JSON includes a schema version and checked paths.
- Exit 0: no errors (warnings allowed); 1: lint failures or warnings with `--strict`;
  2: invalid invocation or inability to complete the check. Missing `SKILL.md` in an
  existing directory is a lint finding, not a usage failure.
- Missing fields/parse errors should suppress dependent checks to avoid cascades.
- Read-only, offline, noninteractive. No automatic changes to generated skills.

Potential fixtures: exact limits and +/-1; whitespace/type failures; directory
mismatch; invalid YAML/non-mapping/duplicate keys; BOM/CRLF; Unicode and scalar
coercion cases; true versus `"true"`; unknown fields; empty body/line threshold;
nonexistent/unreadable paths; safe symlink handling; deterministic JSON and exits.
If links are included, cover code examples, reference-style links, fragments,
encoding, sibling dependencies, and outside-root links explicitly.

## Repository integration constraints

Sources: [root README](../README.md),
[package instructions](../packages/agent-skills/AGENTS.md),
[sync script](../packages/agent-skills/scripts/sync.sh),
[sync tests](../packages/agent-skills/scripts/test-sync.sh),
[manifest](../packages/agent-skills/package.json), and
[CI installer](../scripts/ci-install.sh).

- `skills/` is generated. Fixes belong in translation rules or upstream, never
  hand-edited output. The linter itself should live outside `skills/`.
- Keep generated-output drift validation and generic skill lint conceptually
  separate. The package `check` can run both; root `./scripts/check.sh` already
  delegates package checks/tests.
- All eleven current `SKILL.md` files are under 500 lines. Three currently use
  `disable-model-invocation: true`. This was a source inventory, not a complete
  lint pass.
- Existing symlink prohibition in `sync.sh` is a generated-overlay policy, not a
  general requirement of the Agent Skills specification.
- Adding dependencies requires a committed package lockfile under the current CI
  contract. Update sync-test fixture copying if necessary: it currently copies
  the entire package, which would also copy a newly added `node_modules/`.
- Start by reporting existing warnings before making `--strict` a CI requirement.
