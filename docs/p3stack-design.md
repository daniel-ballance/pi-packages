# pistack: design brief

The package this brief describes is now named p3stack.

Date: **2026-10-15**. Status: **draft for review and implementation.** Companion
to [pstack-on-pi.md](pstack-on-pi.md), which holds the upstream research and
the capability mapping; this document records the decisions taken in
discussion since, the open questions, and the brief for the agent that
implements it.

**pistack** is the Pi edition of Cursor's `pstack`: the whole plugin (router
mode, 23 playbooks, 24 principles, routed and discipline skills, agents,
scripts, guide), **generated deterministically** from a vendored upstream so
that maintenance is: pull the latest pstack, run the generator, run the
checks, push. Hand-editing generated output is forbidden, exactly as for
`packages/pi-pocock-skills`.

Read in this order: §1 principles, §2 baseline, §3 contract, §4 workstreams
(4.0 is the generator), §5 open questions, §6 brief.

## 1. Principles

These apply to every workstream below. The first group is new; the second
restates existing repository rules that the work must not break.

### 1.1 Host parity (new)

Every capability has one host-neutral **contract** that skills are written
against, and a host-native **backend** on each side: Pi in a terminal
("CLI") and Pi launched by T3 Code ("T3", detected by `T3_MCP_URL`, see
`packages/subagents/extensions/subagents/index.ts:44`). Under T3 nothing
duplicates a T3 primitive; under the CLI nothing is missing. The model's
mental model (delegate, wait, cancel cascades, worktree, wake, ask, todo) is
identical; only the tool that satisfies it changes.

1. One shared host helper (`cli` / `t3`) used by every package, instead of
   each extension re-reading `T3_MCP_URL`.
2. Under T3, a tool that duplicates a T3 primitive is registered with
   **`exposure: "deferred"`**, not omitted: discoverable through `tool_search`
   and callable from codemode, never competing in the prompt. (Revised from
   `defaultActive: false`: an inactive `direct` tool is callable only while
   active, so neither codemode nor `tool_search` reaches it. Pi 1.2.0
   `docs/mcp.md`, "Tools with `codemode` or `deferred` exposure can be reached
   through either indirect mechanism"; `docs/extensions.md` "Tool exposure".
   T3's own Pi bridge registers its optional tools as `deferred`.)
3. Every tool result is complete as plain text. `renderCall`, `renderResult`,
   widgets and message renderers are additive, because T3 shows raw results.
4. Every `ctx.ui` call guards on `hasUI`. Without UI, apply a stated default
   and say so in the tool result.
5. Skills name capabilities and resolve tools through one lookup reference
   (the pattern of `packages/pi-pocock-skills/skills/references/CHILD-DELEGATION.md`),
   never backend tool names inline.
6. A semantics-parity list lives in the docs (§3). When one backend gains a
   behaviour, the other gets it or the skill states the gap.
7. Each package that uses the host helper runs its tests twice, with and
   without a fake `T3_MCP_URL`; tests of host-specific behaviour pin their
   host. (Narrowed from "each package": a package with no host-dependent
   code gains nothing from the second pass.)
8. Env detection is the zero-config default. T3's
   `providerInstances.pi.config.launchArgs` (see
   [claude-subscription-t3-400.md](claude-subscription-t3-400.md)) is the
   user's override, not a required step.

### 1.2 Existing rules retained

- `subagents.json` is an **allowlist and ceiling**, whole-file replacement,
  fail-closed. New capabilities must not silently broaden existing
  configurations (`packages/subagents/ROADMAP.md`, "Principles to retain").
  Any new autonomous behaviour (loops, nesting) is off by default.
- Vocabulary from `CONTEXT.md`: Parent, Child, Manager, Composition,
  Allowlist. "Profile", "preset", "role" are rejected names for a
  Composition. A playbook **role default** is a skill-level lookup resolved
  into a full Composition at spawn time; the Allowlist stays the ceiling.
- Work happens in `.pi/worktrees/` branches, never on `main`
  (`.pi/APPEND_SYSTEM.md`).
- Package layout per `README.md` "Package layout and dependencies"; root
  check is `./scripts/check.sh`.

## 2. Baseline: Pi 1.2.0

The research note was written against the 0.99.2 development copy pinned by
`packages/subagents`. The target is the installed Pi **1.2.0**
(`~/.local/share/mise/installs/pi/1.2.0/pi`, docs and `CHANGELOG.md`).
Relevant deltas, all verified in that changelog and `docs/codemode.md`:

- **No native subagent or task tool landed.** Delegation still goes through
  the `subagents` package (CLI) or T3's `delegate_task` (T3).
- **`before_agent_start` fires for `sendMessage(..., {triggerTurn:true})`
  runs** (1.2.0 breaking change). `BeforeAgentStartEvent` is a union on
  `messageType` (`"user"` | `"custom"`); handlers acting only on prompts must
  check it. The session counts as busy while a run starts; `sendUserMessage`
  requires `deliverAs`. This is the mechanism for loops and mode injection.
- **Codemode** (`builtin:codemode`, enable with `defaultTools: ["+codemode"]`):
  QuickJS sandbox calling tools in parallel; only script output reaches the
  model; `store`/`load` persisted as session entries (branch-aware);
  `searchTools`/`describeTool`/`ALL_TOOLS`; `models.classify()` with
  choice/score/bool answers, probabilities and confidence;
  `codemode.mode: "only"` hides declared tools behind scripts. Limits: no
  timers, no nested codemode, 256 MB.
- **Tool patterns** (`--tools 'mcp__x__*'`, `+name`/`-name`),
  `registerToolRenderer()` for tools not yet registered, `reachesTools` on
  tool definitions, `durationMs` on `tool_execution_end`.
- **Removed**: the experimental server/client/plugin stack and the
  `@earendil-works/chord` dependency. `durable-subagents` is out of scope
  (§5.2).

## 3. Capability contract

| Capability | CLI backend | T3 backend | Contract the skill uses |
|---|---|---|---|
| Delegate | `subagent_spawn` / `subagent_wait` / `subagent_read` | `delegate_task` / `task_status` | "delegate with model X, tools Y, cwd Z; wait; read a bounded report" |
| Isolation | `worktree` option on spawn (**to add**, §4.3) | `isolation: "worktree"` | "in its own checkout under `.pi/worktrees/`" |
| Nesting | policy `maxDepth` (**to add**, §4.3) | native; `task_cancel` cascades | "a child may delegate within its subtree; cancel cascades" |
| Wake / loop | `subagent_loop` (**to add**, §4.3) or a watcher child | `schedule_task`, `watch_pull_request` | "wake me on event E or every N minutes until predicate P, bounded" |
| Ask the human | `ask_user` tool via `ctx.ui` (**to add**, §4.4) | the same tool: T3 services Pi's dialogs as pending requests (§5.1, verified) | "ask only for product or preference calls; otherwise apply a default and report" |
| Todo | `todo` package (**to add**, §4.2) with TUI widget | same tool, plain-text result | "copy playbook steps verbatim; `done` or `skip: <reason>`" |
| Visuals | widget / rendered tool result | `html_render` | "show it" |
| Status | `ui.setStatus`, OSC 7501 program status (Pi 1.1) | thread status | n/a |
| Model catalog | `modelRegistry.getAvailable()` + `subagent_catalog` | `orchestrator_capabilities` | "list what I may use for role R" |
| PR watch | watcher child running `gh` | `link_pull_request`, `watch_pull_request` | "tell me when CI, reviews or conflicts change" |
| Session history | Pi `sessions/` JSONL via `ctx.sessionManager.getSessionFile()` | same (T3 stores the native session path) | "mine this project's recent sessions only" |

## 4. Workstreams

Each is independently shippable. Suggested order: 4.1 → 4.0 (generator
skeleton with a first skill) → 4.2 → 4.3 → 4.4 → 4.5. 4.3 is the largest and
the only one that changes an existing contract; 4.0 is the one that decides
whether maintenance stays cheap.

### 4.0 Generator: pstack → pistack

Package `packages/pistack`. Upstream vendored as a git submodule at
`packages/pistack/vendor/pstack` (the `cursor/plugins` repo, sparse to
`pstack/`, pinned by commit; MIT, LICENSE carried through). Follows the
`pi-pocock-skills` contract (`packages/pi-pocock-skills/AGENTS.md`): `skills/`,
`agents/`, `scripts/`, `docs/` outputs are **generated**, the check fails on
drift, and the only hand-maintained inputs are the generator and its rules.

Why a plain `sed` overlay is not enough: pstack's Cursor coupling is semantic
(`Task` fields, slug fallbacks, cloud environments, `.mdc` rules). The
generator is therefore a **rule pipeline with three rule kinds**, applied in
order, each deterministic (same input and rules → byte-identical output):

1. **Token rewrites**, table-driven, global. `/name` → `/skill:name`;
   `AskQuestion` → the `ask_user` contract; `~/.cursor/rules/pstack-models.mdc`
   → `~/.pi/agent/pistack.json`; `agent-transcripts/` → the Pi sessions
   contract; `create-skill` → `writing-for-agents` + `lint-skill`; `bun` →
   `tsx`; `/add-plugin pstack` → `pi install`; names (`pstack` → `pistack`,
   `poteto-mode` kept as the mode name unless the user renames it).
2. **Section replacements**, keyed on heading text. Whole sections whose
   content is host-specific are replaced from `overlays/<skill>/<heading>.md`:
   poteto-mode "## Subagents" (delegation contract from §3, role defaults,
   thinking ladder), `setup-pstack` steps 1 and 5 (model detection and the
   JSON file), `swarm` Phase B, `interrogate` Step 3, `arena` Phase A step 3,
   `why` MCP discovery, `recall`/`reflect`/`automate-me` transcript location.
   A heading that disappears upstream fails the build with its name.
3. **Per-file patches**, unified diffs under `patches/`, applied with
   `git apply --check` then `git apply`. For edits too small for a section
   and too specific for a token. A patch that no longer applies fails the
   build; the maintainer rebases it. This is the escape hatch, kept small.

After generation, a **coupling lint** runs over every emitted file and fails
on any remaining Cursor-only token: `Task tool`, `subagent_type`,
`run_in_background`, `environment: "cloud"`, `cloud_base_branch`,
`AskQuestion`, `.cursor`, `.mdc`, `/loop` (Cursor's), `generalPurpose`,
`cursor-team-kit`, `bun `. The lint's deny-list is the contract that makes an
upstream bump safe: a new Cursor-ism cannot reach `main` unnoticed; it
surfaces as a failing check that names the file and token, and the fix is a
new rule, never an edit to the output.

What each upstream artifact becomes:

| Upstream | pistack output | Rule kind |
|---|---|---|
| `skills/*/SKILL.md`, `playbooks/`, `references/` | `skills/` (same tree); principles stay separate skills with `disable-model-invocation: true` (Pi omits them from the prompt, `/skill:principle-x` still works) | 1, 2 |
| `agents/poteto-agent.md`, `comment-sicko.md` | `agents/*.md` reference files the mode skill cites as `appendSystemPrompt` recipes for a Composition (a "persona" is a composition recipe, not a preset) | 1, 3 |
| `scripts/orch`, `scripts/watch-pr`, `check-plan.mjs`, `worktree-audit.sh`, `show-me-your-work/scripts/log.sh` | `scripts/` runnable under Node 22 + `tsx`; `bootstrap.ts` dropped, deps in the package manifest; upstream's own tests run in the package `test` script | 1, 3 |
| `docs/guide/` | `docs/guide/` translated (low priority; may be excluded by a rule) | 1 |
| `automations/benny/` | `automations/benny/` as a dormant reference plus a note mapping Cursor automations to T3 `schedule_task` webhooks; not registered as skills | 1 |
| `plugin.json` | `package.json` `pi` manifest; version recorded as `pistack.upstream` | generator |

Package scripts, mirroring `pi-pocock-skills`:

- `sync`: `git submodule update --init`, generate into `skills/` etc.
- `check`: regenerate to a temp dir and diff against the committed tree
  (drift), coupling lint, `lint-skill` on every SKILL.md, `tsc --noEmit` on
  ported scripts.
- `test`: upstream script tests under `tsx`, generator unit tests (each rule
  kind on fixtures), and a smoke test that loads the package through Pi's
  real loader (the packaging regression the root check already runs).
- `eval` (manual, not in the root gate): pstack's own eval playbook, blinded
  judge on a different model family via `models.classify()`, run on a fixed
  task set with and without the mode skill. Records results under
  `docs/evals/<date>.md`.

Upstream bump procedure, scripted as `scripts/bump-upstream.sh`: fetch the
submodule to the new commit → `sync` → `check` → `test` → if green, commit
"Bump pstack to <sha>" on a `pistack/bump-<sha>` branch and open a PR. The
repository rule "never work on `main`" holds; the fast-forward to `main`
happens through that PR's merge, which CI gates with the same scripts.
If `check` fails, the failure names the rule to add or the patch to rebase.

### 4.1 Host helper

A tiny shared module (location to decide: a `packages/host` package, or a
file duplicated per package since packages load with separate module roots,
see Pi `docs/packages.md`) exporting `detectHost(): "cli" | "t3"` and
`registerHostAware(pi, tool, { duplicatesT3: boolean })` which sets
`defaultActive` per §1.1 rule 2. Migrate `subagents`' existing check to it.

### 4.2 `todo` package

New package `packages/todo`. One tool with operations:

- `set(items[])`: replace the list (used to copy a playbook's steps verbatim).
- `update(id, state, note?)`: `pending` | `in_progress` | `done` | `skipped`;
  `skipped` **requires** a non-empty reason (schema-enforced). Items are
  never deleted; a wrong step is marked skipped with a reason.
- `get()`.

Later additions: `add(items[])` appends; `update` also takes `ids`, `text` (one
item) and a note on its own; `remove(ids)` deletes only `pending` items, for
duplicates and mistakes. A step started or decided against still ends `done`
or `skipped` with a reason.

Persistence: each change is an `appendEntry` custom entry; state is rebuilt
from entries on `session_start` and on branch navigation so `/fork`,
`/tree` and resumed sessions see the right list. UI: `ui.setWidget` panel in
the TUI, `registerMessageRenderer` for the transcript, and a plain-text
result on every call (rule 3). `outputSchema` so codemode scripts receive
structured results. An `agent_end` handler notifies on open `in_progress`
items. Under T3, active (T3 has no Pi-side todo) unless a T3 todo tool is
detected, in which case inactive per rule 2.

**Implemented (workstream `todo`).** Two deviations, with reasons: (1) the
"skipped requires a reason" rule is enforced when the call arrives, not in the
schema, because providers require tool parameters to be one flat object; the
error result names the rule and shows the unchanged list. (2) The package is
opt-in, outside the collection manifest, like `pistack`. `appendEntry` is kept
over tool-result `details` (Pi's own todo example) because codemode's nested
calls write no transcript entries, so `details` would lose their changes.

### 4.3 `subagents` package changes

**(a) Wake / loop.** Parent-side `subagent_loop` (and `/loop` command): on an
interval, `sendMessage({customType:"subagent-loop-tick", ...},
{triggerTurn:true, deliverAs:"nextTurn"})` until the model calls
`subagent_loop({op:"stop"})`, `/loop stop`, or the bounds are hit. Reuses the
notification machinery in `src/notifications.ts`. Policy field, default
disabled, mirroring workflow bounds:

```json
"loops": { "enabled": true, "minIntervalMs": 60000, "maxIterations": 50, "maxDurationMs": 28800000 }
```

Inactive under T3 (`schedule_task` / `watch_pull_request` exist there).
Note that event-driven wakes need no new code: a child whose task is "watch X,
report" wakes the parent on completion.

**(b) Worktree option on spawn.** `worktree: true | { base?: string }` on
`subagent_spawn` creates `git worktree add` under `.pi/worktrees/<name>` and
sets `cwd` to it. Creation only; merging stays out (ROADMAP "automatic
worktree/source merging" remains deferred). Policy: `workingDirectories`
already permits descendants of `.`; add nothing unless a repo keeps
worktrees elsewhere.

**(c) Lift the non-recursion invariant, shape (b).** Today: the manager
registers no tools when `PI_SUBAGENT=1`, `child-guard.ts` `permits()`
rejects any `subagent_*` name, and the docs declare recursion forbidden.
Chosen shape: **one root Manager, proxied tools.** A child at depth `d <
maxDepth` receives a proxied `subagent_*` toolset that forwards
spawn/send/wait/read/close over the existing private process-bound
transport (`src/peer-transport.ts`, the fd-3 channel `peer_send` uses) to
the root Manager, which composes grandchildren from the **same Allowlist**,
stamps depth and parent ID, and owns the whole tree. Consequences:

- Holds, Halt/Kill, cost totals and the `/subagents` inspector cover the whole
  tree (inspector becomes a tree view). Close and cancel cascade down a
  subtree, matching T3's `task_cancel`.
- Notifications route to the immediate parent only. The root sees its direct
  children's notices; a sub-coordinator rolls up.
- Children manage only their own subtree: no policy editing, no human-approval
  authority, no peer links outside the subtree. The ROADMAP principle is
  reworded accordingly, not deleted.
- Policy fields: `maxDepth` (integer, default **1** = today's behaviour, so no
  existing configuration broadens) and `maxDescendants` (tree-wide cap)
  alongside per-node `maxChildren`.
- Workflow workers still do not orchestrate (`WORKFLOWS.md`); unchanged.
- The rejected alternative, nested managers (each child runs its own
  Manager), is simpler but loses holds, inspection, accounting and orphan
  cleanup below depth 1. Record this as an ADR.

**Implemented (workstream `subagents-recursion`)**, with two deliberate
differences, recorded in ADR 0002: (1) no `maxDescendants` field. One root
Manager owns every Child, so `maxChildren`, already "the live-process cap,
including idle children", is the tree-wide cap; a per-node reinterpretation would
have changed an existing field's meaning. (2) A nested Child's routine reports
are pulled by its parent (`subagent_wait`/`subagent_read`), not pushed: pushing
a report into a Child through `subagent_send` would register it as a new
assignment. Human-intervention notices still go to the root, as do reports from a
Child whose parent stopped. The proxied set is `catalog`, `spawn`, `send`,
`wait`, `read`, `close`, `list`.

pstack's own warning sets the default posture: "each nested layer re-pays a
full orientation preamble, and a blocking sub-coordinator hides its children
while the parent idles." Depth is allowed; the orchestrate playbook opts in.

**(d) Compatibility.** Before any of the above, run the package checks
against Pi 1.2.0 (it pins 0.99.2 for development) and decide whether to bump
the pin. Done (§5.2): one characterization fixture to fix, pin kept.

### 4.4 `pistack` package: generated skills plus a hand-written extension

The package has two halves. `skills/`, `agents/`, `scripts/`, `docs/guide/`
are generated by 4.0 and never edited. `extensions/pistack/` and
`overlays/`, `patches/`, `rules/` are hand-written.

**Generated skills (all of pstack).** The full tree, not a subset. Playbooks
that depend on 4.3 (babysit, shipping, orchestrate, autopilot-full/stack) are
still emitted; their overlay sections state the CLI prerequisite (loop,
nesting) and the T3 equivalent, so the skill is honest on both hosts from
day one. Rules that need deciding before the first full generation:

- Principles: emitted as 24 skills with `disable-model-invocation: true`
  (prompt cost zero per `formatSkillsForPrompt`; `/skill:principle-x` works;
  the mode skill references them by path). Decision: keep separate, matches
  upstream and keeps the generator simple.
- Role defaults file `~/.pi/agent/pistack.json` (or `.pi/pistack.json` in a
  trusted project): `{"budget": "...", "roles": {"code": "provider/model:thinking", "judgment": "...", "swarm workers": "...", "interrogate reviewers": ["...", "..."]}}`.
  Values must be exact Pi identities permitted by the Allowlist (CLI) or by
  `orchestrator_capabilities` (T3). Thinking ladder derived from each model's
  `thinkingLevels`, not hard-coded tokens; no "fast" variants.
- Overlap with `pi-pocock-skills` (`tdd`, `code-review`, `research`,
  `diagnosing-bugs`, `writing-for-agents`): a rule table `rules/routes.json`
  maps each pstack skill name to `emit`, `alias` (emit a one-paragraph skill
  that points at the pi-pocock-skills one) or `replace`. Decide per skill before
  the first generation so every playbook step names one skill.

**Extension (hand-written).** `/pistack-setup` (model detection via
`modelRegistry` + `subagent_catalog` or `orchestrator_capabilities`;
`ui.select` for budget and roles; validates every id; writes the file),
`pistack_roles` tool, mode toggle (`before_agent_start` → `systemPrompt`
append, persisted with `appendEntry`, `ui.setStatus`), `ask_user` tool, child
preamble helper (prepend the mode skill path to brokered tasks, replacing
`poteto-agent`). `/loop` and todo come from 4.3 and 4.2, not here.

**Implemented (workstream `pistack-extension`).** `/pistack-mode on|off|status`
(a `before_agent_start` prompt section rather than a replaced system prompt, so
Pi records a delta), `ask_user` (`model-only`), `pistack_roles`, `/pistack-setup`
and the child brief prefix for `subagent_spawn` and T3 `delegate_task`. Choices:
the extension is written against the subset of Pi's API it uses, so pistack needs
only `typebox` and no Pi SDK of its own (no tenth host for the security patch);
the package-layout test loads it through Pi's real loader. `/pistack-setup`
offers only identities the subagents allowlist permits (a command cannot call
`subagent_catalog`, so subagents replies on the `subagents:catalog` event-bus
channel), never above the chosen budget, and
covers the common case (one code and one judgment model) and defers to
`/skill:setup-pstack` under T3, whose catalog only the model can read.

**Read-only delegates (decided 2026-10-15).** Upstream's `poteto-agent` recipe
makes every Child read the full mode skill. In stress tests, small read-only
workers spent their first turns on that 20 KB read and started playbooks of
their own; a three-file nested audit took about 15 minutes. The brief prefix now
gives a terminal Child with none of `edit`, `write` or `subagent_spawn` a short
recipe instead: answer the brief with evidence, no playbook, no delegation.
Editing Children and coordinators keep the full recipe. A T3 `delegate_task`
carries no tool list, so its brief always keeps the full recipe.

**Layer 3: not built (decided 2026-10-15).** The parent composes fan-outs
itself from the tools (`subagent_*` or T3's, codemode where it helps) as the
skills' prose directs, rather than from prebuilt programs. Stress tests on both
hosts showed the prose versions working: arenas landed, swarms ran in waves
under the live-Child limit, cross-family judges ran. Prebuilt programs would
duplicate each skill in code, have to track two hosts' tool names, and stop
upstream skill changes reaching pistack through the generator. Revisit if
parent context runs out in real sessions (a TUI parent reached 59% of 500k
after six stress tasks) or fan-outs prove inconsistent. The design below is
kept for that case.

**Layer 3, programs via codemode + workflows (not built; see above).** Fan-out skills (`swarm`,
`arena`, `interrogate`) are expressed as codemode scripts: spawn N in
`Promise.all`, wait, reduce N reports to a compact table in-script so raw
worker output never reaches the model. Orchestrate compiles a track into a
workflow definition and starts it with `subagent_workflow_start`;
verification steps are checks on a different model family; `models.classify()`
serves as the blinded cross-judge for arena/eval and for de-duplicating
interrogate findings (its confidence satisfies the "explain the number"
rule). "Author the next wave's briefs" is an agent task whose artifact the
parent turns into the next workflow start. `watch-pr` is ported to `tsx` only
if plain-CLI babysit is wanted; under T3 use `watch_pull_request`.

### 4.5 Documentation and vocabulary

- Add §1.1 to `CONTEXT.md` as a section ("Host parity") and the role-default
  term. Add a one-line pointer in `AGENTS.md`.
- ADRs: (1) host parity; (2) recursion shape (b) with the rejected
  alternative; (3) loops as bounded policy, not behaviour config.
- Update `packages/subagents/README.md` "Non-recursion" and ROADMAP wording
  when 4.3(c) lands; update `skills/subagents/reference/configuration.md`
  for new policy fields.

## 5. Open questions and things to verify first

1. **Does T3's Pi RPC adapter service Pi's extension-UI dialogs**
   (`docs/rpc-extension-ui.md`)? If yes, `ask_user` and `/playbooks-setup`
   work unchanged under T3 and several §3 rows collapse. Test with a trivial
   `ctx.ui.confirm` tool inside a T3 thread.

   **Resolved 2026-10-15: yes.** Live probe: a throwaway project extension
   registered `ui_probe` (calls `ctx.ui.confirm`, `select`, `input`); a T3
   delegated task on the Pi provider (T3 0.0.46-nightly.20261014, Pi 1.2.0,
   `openai-codex/gpt-6-luna`) called it. Result: `mode: "rpc"`,
   `hasUI: true`, `T3_MCP_URL` set; the confirm surfaced as a T3
   `approval_request`, select and input as `user_input_request` items, all
   answered in the T3 UI and returned to the tool (`true`, `"alpha"`, `""`).
   Static confirmation in T3's bundled Pi adapter
   (`handleExtensionUiRequest`): `select`/`confirm`/`input`/`editor` become
   runtime requests answered with `extension_ui_response`; `notify` becomes a
   transcript item; `setStatus`, `setWidget`, `setTitle` are ignored
   ("Ignoring pi extension UI update"). T3's injected Pi extension itself
   routes tool approvals through `ctx.ui.confirm`. Consequences: the §3 "Ask
   the human" row collapses to one backend (the `ask_user` tool, active on
   both hosts); `/pistack-setup` dialogs work under T3. `t3_pending_request_list`
   excludes approval requests, so a parent agent can answer `select`/`input`
   programmatically but not `confirm`. Status and widgets are invisible
   under T3, which is why rule 3 (plain-text-complete results) matters.
   An earlier attempt failed at launch with "pi process exited with code 1";
   T3's trace shows the same failure in `discoverPiCommandsForCwd` before the
   probe existed, and an immediate retry succeeded, so it is a transient T3
   launch issue, not a probe result.
2. **`subagents` and `durable-subagents` on Pi 1.2.0.** Run both packages'
   checks on 1.2.0; check `durable-subagents` after the `chord` removal.

   **Resolved 2026-10-15.** Method: `npm ci`, then `npm install --no-save`
   of `@earendil-works/pi-{ai,coding-agent,tui}@1.2.0` into
   `packages/subagents`, the same override shape `scripts/ci-install.sh`
   uses for its 0.99.2 job.
   - `subagents`: `tsc --noEmit` passes on 1.2.0. Tests: 264 pass, 12 skipped
     (herdr end-to-end, as on 0.99.2), **1 fail**:
     `builtins-probe-rpc.test.ts` "stock built-ins". It characterizes Pi
     itself, not the package: its fixture calls `models.classify()` with
     `questions: {}`, which 1.2.0 rejects ("context.questions must map
     question IDs to questions"), and 1.2.0 packs codemode output into a
     different text block. Fix the fixture to pass a valid question and match
     on block content; no package code change. Decision for 4.3(d): keep the
     0.99.2 development pin for now (CI and both lockfiles are built on it)
     and add a 1.2.0 job; new code uses only APIs present in both
     (`exposure`, `defaultActive`, `outputSchema`, `appendEntry`,
     `sendMessage` with `deliverAs` all exist in the 0.99.2 and 1.2.0
     `types.d.ts`).
   - `durable-subagents`: **out of scope** (an experiment, not in regular
     use). For the record only: it pins its own `@earendil-works/chord@1.0.0`,
     so Pi's chord removal does not affect it, but its extension entry point
     refuses any Pi other than 0.99.2 and 1.0.x. pistack does not depend on
     it.
3. **Thinking levels per provider.** Confirm the enum each provider exposes
   (`LocalModel.thinkingLevels` in `policy.ts`) before writing the budget
   ladder.

   **Resolved 2026-10-15.** Pi's `ModelThinkingLevel` is `off | minimal | low |
   medium | high | xhigh | max` (`pi-ai` `types.d.ts`); each model supports a
   subset (`getSupportedThinkingLevels`). Live catalog on this workstation:
   `openai-codex/gpt-6.1-sol` minimal–max, `xai/grok-4.7` low–xhigh,
   `claude-subscription/claude-opus-5-5` low–max, `claude-fable-5-1`
   minimal–max, `halogen/qwen3.8-flash-next-w4b` off–xhigh. pstack's budget
   ladder (`unlimited/large/medium/small` → `max/xhigh/high/medium`) maps onto
   these names directly; clamp to the closest supported level below. No speed
   tier exists, so `-fast` hints are dropped.
4. **Session file layout per cwd** for the history-mining skills, and the
   privacy rule (this project only).

   **Resolved 2026-10-15.** `~/.pi/agent/sessions/--<path>--/<timestamp>_<id>.jsonl`,
   where `<path>` is the cwd without its leading separator and with `/`, `\`
   and `:` replaced by `-` (Pi 1.2.0 `docs/session-format.md`); `--session-dir`,
   `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` move it. Skills read only the
   current cwd's directory, as stated in the capabilities reference.
5. **Does T3 inject a todo tool for Pi?** Decides the todo tool's T3
   activation.

   **Resolved 2026-10-15: no.** The §5.1 probe listed every registered tool
   in a T3 Pi session: built-ins, `mcp__t3-code__*` (preview, orchestration,
   threads, queue, PR, device, html), the user's own extensions and MCP
   servers; nothing todo-shaped. The todo tool is therefore `direct` under
   both hosts. Keep the detection (a registered tool named like a todo
   primitive switches ours to `deferred`) so a later T3 release that adds
   one does not create a duplicate.
6. **Concurrency defaults.** `maxChildren` is 4; `swarm` must read the cap
   from `subagent_catalog` and shape N to it rather than fail.
7. **Package naming**: `pistack` is decided. `host` helper as a package or a
   vendored file is open.

   **Resolved 2026-10-15 (workstream `host`): a generated copy.** One source,
   `shared/host.ts`, copied by `scripts/sync-shared.mjs` into each package
   listed in `shared/copies.json`, with a drift check in `./scripts/check.sh`.
   A workspace package was rejected: Pi loads each package from its own module
   root (`docs/packages.md`), so a copied-out or individually installed package
   would need the helper published as a runtime dependency, and adding a
   workspace dependency means the seeded lockfile refresh for both managers.
   A copy costs neither. `subagents` keeps omitting its tools under T3 instead
   of registering them `deferred` (the user's decision: under T3, use T3's
   native delegation only). Rule 2 is for a tool that duplicates a T3
   primitive, while `subagents` duplicates the whole delegation system
   (Manager, Children, workflows, footer, herdr status), and a deferred
   `subagent_spawn` would let a T3 session spawn Children outside T3's task
   tree.
8. **Generator rule budget.** How many per-file patches (rule kind 3) does the
   first full generation need? If it is most files, the section-replacement
   rules are too coarse and need refining before the tree is committed; the
   target is that token rewrites and section overlays cover nearly everything
   and patches stay in the single digits.

   **Measured 2026-10-15 (first full generation):** 118 token rules (34 global,
   84 scoped to one file's sentence), 5 section overlays, **0 patches**. Of 112
   emitted upstream files, 55 are translated and 57 pass verbatim; the coupling
   lint and `lint-skill` (0 errors) are clean. **After review and the scripts
   port:** 160 token rules, 5 overlays, **1 patch** (`worktree-audit.sh`, whose
   multi-line shell changes have no sentence to anchor a token rule). The file-scoped count is the cost
   of upstream restating Cursor mechanics in prose; each such rule is a tripwire,
   so an upstream rewording fails loudly instead of leaking a Cursor-ism.
   `make-bot-ui` (Cursor's Grok Bot routines) is excluded with `automations/benny`.
9. **Mode name.** Keep `poteto-mode` (upstream attribution, `/skill:poteto-mode`)
   or rename (`/skill:pistack`)? A rename is one token rule either way.

   **Decided 2026-10-15 (user): keep `poteto-mode`.**
10. **Decisions taken while building the generator (2026-10-15, user where
    marked).**
    - Overlap with `pi-pocock-skills` (user): pistack is self-contained; every
      skill, agent and script lives in `packages/pistack`, nothing is routed
      to `pi-pocock-skills`, so `rules/routes.json` is dropped. Upstream names are
      kept; `tdd` collides by name with `pi-pocock-skills`' `tdd` only when both
      are enabled, and the README says so. pistack stays out of the root
      collection manifest (opt-in, like `durable-subagents`) so the collection
      never loads two `tdd` skills.
    - `automations/benny` and `docs/guide` (user): excluded from the first
      generation.
    - `todo` (user): a standalone package; pistack uses it but does not
      contain it.
    - Upstream scripts live inside the skills tree
      (`skills/poteto-mode/scripts/`), so there is no separate generated
      `scripts/` root; hand-written tooling lives in `generator/`.
    - Section replacements record a hash of the upstream section they replace
      and fail when upstream edits it, so an overlay cannot silently hide an
      upstream change.
    - Pi-native additions (the capabilities reference) live in `extra/` and
      are copied into the output untouched, then linted.
    - The capabilities lookup reference is
      `skills/poteto-mode/references/host-capabilities.md`; skills link it
      instead of naming backend tools.

## 6. Brief for the implementing agent

You are implementing the design above in this repository. Constraints:

- Work in a worktree under `.pi/worktrees/`, one branch per workstream
  (`host`, `pistack-generator`, `todo`, `subagents-loop`,
  `subagents-worktree`, `subagents-recursion`, `pistack-extension`). Never
  commit to `main`.
- The generator (4.0) comes before any generated content is committed.
  Never hand-edit a generated file; if the output is wrong, fix a rule and
  regenerate. The drift check must be part of `./scripts/check.sh` from the
  first commit, as it is for `pi-pocock-skills`.
- Read first: this file; [pstack-on-pi.md](pstack-on-pi.md); `CONTEXT.md`;
  `README.md` ("Package layout", "Repository check"); for 4.3,
  `packages/subagents/README.md`, `ROADMAP.md`, `WORKFLOWS.md`,
  `PEER-MESSAGING.md`, `src/policy.ts`, `src/child-guard.ts`,
  `src/peer-transport.ts`, `src/notifications.ts`, `src/manager.ts`; for Pi
  facts, the installed 1.2.0 `docs/` and `CHANGELOG.md` rather than the
  0.99.2 copy in `node_modules`.
- Resolve §5 items 1 and 2 before writing code that depends on them; record
  each answer in this document's §5 with evidence.
- Every new tool follows §1.1 rules 2, 3, 4 and 7. Every new policy field is
  off by default and documented in the subagents configuration reference.
- Use the `tdd` and `code-review` skills from `pi-pocock-skills` for each slice;
  the root check `./scripts/check.sh` must pass with both npm and pnpm
  layouts as described in `README.md`.
- Deliverables per workstream: code, tests (including the fake-`T3_MCP_URL`
  variant), README updates, and an ADR where §4.5 names one. Open one PR per
  workstream against `main`, stacked only where a dependency is real
  (`pistack-extension` depends on `todo` and 4.3(a); `pistack-generator`
  depends on `host` only for the lint's host-neutral token list).
- When pstack prose is ported, keep the upstream pin and LICENSE, and apply
  the `writing-for-agents` skill and `lint-skill` to every SKILL.md.
- Report back with: what landed per workstream, which §5 items were resolved
  and how, and any contract row in §3 that could not be satisfied on one host.
