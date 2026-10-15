# pstack on Pi: research and implementation options

Date: **2026-10-15**. Status: **research; no decision taken.**

Question: what is Cursor's `pstack` plugin, what does it actually depend on,
and how could the same system be built for Pi using the Pi API surface and the
packages already in this repository?

Source inspected: `cursor/plugins` at commit
[`e5136d8`](https://github.com/cursor/plugins/tree/e5136d82418d2db3165ea1050d17577cd618cc05/pstack)
(2026-10-15), subtree `pstack/`, version `0.15.25`, MIT. Links below are pinned
to that commit. Pi facts come from the pinned development copy of
`@earendil-works/pi-coding-agent` 0.99.2 under `packages/subagents/node_modules`
(its `docs/` and `dist/core/extensions/types.d.ts`). Claims about this repo's
packages cite their README or source.

## 1. What pstack is

pstack is a Cursor plugin by Lauren Tan (poteto) that turns one chat into a
rigorous engineering process. The pitch in
[`README.md`](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/README.md):
"write less, but higher quality code" and "fearless parallelism" by making a
single agent trustworthy enough to run many at once.

It is almost entirely prose. The repo has no plugin runtime code; the only code
is a handful of helper scripts a skill tells the agent to run. The
[`.cursor-plugin/plugin.json`](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/.cursor-plugin/plugin.json)
manifest declares only `"skills": "./skills/"` and `"agents": "./agents/"`.

### 1.1 Layers

| Layer | Files | What it does |
|---|---|---|
| **Router mode skill** | [`skills/poteto-mode/SKILL.md`](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/skills/poteto-mode/SKILL.md) | Entry point. Matches the task to one of 23 playbooks, opens a todo list with the playbook's steps copied verbatim, routes to other skills as steps fire, sets autonomy rules ("just do it", always pause on irreversible writes), reply style, and subagent defaults. `disable-model-invocation: true`. |
| **Playbooks** | `skills/poteto-mode/playbooks/*.md` (23) | One file per task shape: investigation, bug-fix, feature, refactoring, perf, hillclimb, prototype, babysit, shipping, autonomous-run, orchestrate, autopilot-full/stack, session-pickup, pause-safely, eval, opening-a-pr, … |
| **Principles** | `skills/principle-*/SKILL.md` (24) | One rule each, indexed inline in the mode skill with "when it applies". The agent must read the leaf before citing it. |
| **Routed workflow skills** | `how`, `why`, `architect`, `arena`, `swarm`, `interrogate`, `reflect`, `recall`, `automate-me`, `teach`, `figure-it-out`, `blast-radius` | Each fans out subagents with a per-role model and synthesises. The adversarial signal in [`interrogate`](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/skills/interrogate/SKILL.md) "comes from model diversity, not assigned personas". |
| **Discipline skills** | `unslop`, `no-comments`, `technical-writing`, `tdd`, `typescript-best-practices`, `benchmark-checklist`, `correct`, `sharpen`, `in-your-own-words`, `ketchup`, `bro`, `poteto-help` | Pure prose rules; no delegation. |
| **Per-role model config** | [`skills/setup-pstack/SKILL.md`](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/skills/setup-pstack/SKILL.md) | Detects available `Task` model slugs, asks for a reasoning budget (`unlimited/large/medium/small` → `max/xhigh/high/medium`), and writes `~/.cursor/rules/pstack-models.mdc` with `alwaysApply: true` and one line per role (`feature, refactoring`, `judgment and prose`, `swarm workers`, `interrogate reviewers`, …). Every routed skill reads that line and falls back to a default. |
| **Agents** | [`agents/poteto-agent.md`](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/agents/poteto-agent.md), [`agents/comment-sicko.md`](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/agents/comment-sicko.md) | `poteto-agent` is a wrapper persona for delegates: it must read the mode SKILL.md in full before working. `comment-sicko` is a read-only comment reviewer. |
| **Decision trail** | [`skills/show-me-your-work/SKILL.md`](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/skills/show-me-your-work/SKILL.md), `scripts/log.sh` | Append-only TSV (`ts, phase, decision, why, evidence, result`), audited against the transcript at run end, then cross-reviewed by a subagent on a different model family. |
| **Scripts** | `skills/poteto-mode/scripts/` | `orch/` (590+1677 lines, bun + commander): plain-file store for the orchestrate playbook (`units.tsv`, `ledger.tsv`, `inbox/`, `gates.md`, `frontier.json`, `preferences.md`). `watch-pr/` (~2.5k lines incl. tests): `gh`-backed PR watcher with typed verdicts (`CiState`, `MergeBlocker`, `PrSnapshot`). `check-plan.mjs` lints multi-phase plan files. `worktree-audit.sh`. `bootstrap.ts` self-installs deps keyed on a lockfile hash. |
| **Automations** | `automations/benny/` | Dormant pack for Cursor automations (Slack triage → reproduce → draft fix). Not slash skills. |
| **Guide** | `docs/guide/*.md` | Ten-page tutorial. |

### 1.2 The core mechanics worth copying

1. **Routing by playbook, with the steps copied into a todo list verbatim.**
   A skipped step stays in the list with `skip: <reason>`. This is what makes a
   run auditable without reading the transcript.
2. **Principles as an index plus leaves.** The index costs little context; the
   leaf is read only when applied, and the reply must name which principle
   changed which decision.
3. **Role-based model routing with a user-owned override file.** Skills name a
   role, not a model. Defaults split work by model strength (code to one
   family, judgment and prose to another). Panels are lists; list length sets
   fan-out. `inherit-parent` / `auto` mean "omit model".
4. **Model-diverse review.** `interrogate`, `arena` cross-judge, `eval`'s
   blinded judge, `show-me-your-work`'s trail review all require a different
   model family from the one that did the work.
5. **Fresh subagents by default, with consolidated scope.** Resume only when
   state is costly to move (a checkout, uncommitted changes, a running process).
6. **Brief as the product.** The orchestrate playbook's brief template
   (`GOAL / SCOPE / CONTEXT / ACCEPTANCE / VERIFY / TIMEBOX / FORBIDDEN / REPORT /
   STANDING`) and the rule "a field you cannot fill is a unit you have not scoped
   yet" ([orchestrate.md](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/skills/poteto-mode/playbooks/orchestrate.md)).
7. **Never block on the human, but always pause on irreversible writes.**
   Empirical forks are settled by prototype, not by asking.
8. **A decision log that is audited and cross-reviewed.**

### 1.3 What it depends on from Cursor

These are the parts that do not come for free on Pi. Each is cited to the file
that assumes it.

| Cursor feature | Where assumed |
|---|---|
| `Task` tool with `subagent_type`, `model`, `readonly`, `run_in_background`, `environment: "cloud"`, `cloud_base_branch` | poteto-mode Subagents section; `swarm` Phase B; `interrogate` Step 3; orchestrate "Roles and placement" |
| Named agent personas (`agents/*.md`, `subagent_type: "poteto-agent"`) | README; poteto-mode Subagents |
| Model slugs with effort and speed tokens (`claude-opus-5-5-xhigh`, `grok-4.7-xhigh-fast`) and a fallback ladder when a slug is rejected | setup-pstack step 3; every routed skill |
| Always-applied rules (`~/.cursor/rules/*.mdc`, `alwaysApply: true`) | setup-pstack step 5 |
| Custom modes (option+enter keeps a skill on across turns) | README "usage" |
| `/loop` built-in | autonomous-run step 2; README |
| `AskQuestion` structured tool | poteto-mode Non-negotiables; automate-me step 2; setup-pstack |
| Todo list tool | poteto-mode Playbooks; swarm/arena "open a todolist" |
| `agent-transcripts/` path in the system prompt (`~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`) | recall, reflect, automate-me, show-me-your-work audit |
| MCP discovery (`mcps/` directory, available-tools map) | `why` |
| Cursor built-ins `create-skill`, `babysit`; `cursor-team-kit` (`deslop`, `control-ui`, `control-cli`) | README "not shipped here"; poteto-mode triggers |
| `~/.cursor/plugins/` layout for locating the mode skill | poteto-agent |
| bun for scripts | `scripts/package.json`, `bootstrap.ts` |

## 2. Pi capability mapping

For each pstack dependency: what Pi (0.99.2) or this repo already offers, and
the gap.

| pstack needs | Pi / this repo offers | Gap |
|---|---|---|
| Skills with `disable-model-invocation`, invoked by slash command with arguments | Pi implements Agent Skills; `/skill:name args` appends args as a user request; `disable-model-invocation` is honoured ([docs/skills.md](#sources)); `enableSkillCommands` setting controls command discovery. | None. Command names are `/skill:<name>` rather than `/<name>`. An extension can `registerCommand("poteto-mode")` as a short alias that calls `ctx.sendUserMessage("/skill:poteto-mode …", {expandPromptTemplates:true})`. |
| Subagent spawn with per-call model, read-only mode, background execution | `subagents` package: `subagent_spawn` takes exact `provider/model:thinking`, an explicit `tools` array (read-only = omit `edit`/`write`/`bash`), `cwd`, `appendSystemPrompt`; returns acceptance, with `subagent_wait`/`subagent_read` for results ([README "Tools"](../packages/subagents/README.md)). Inside T3 Code: `delegate_task` with `target.model`, `orchestrator_capabilities` for the live catalog, `task_status`. | Two backends with different tool names. `agent-skills` already has a backend-neutral delegation reference (`skills/references/CHILD-DELEGATION.md`) the research skill uses; pstack-derived skills should write against the same abstraction. |
| Named agent persona (`poteto-agent`) | No Pi equivalent. The closest is a spawn composition: `appendSystemPrompt` plus `skills: [<mode skill>]` so the child sees the mode skill, and a task preamble "read `<abs path>/SKILL.md` first". Durable-subagents and T3 also take a task prompt only. | The "must read the mode skill in full" guarantee is prompt-enforced on Cursor too. On Pi it can be *tool-enforced*: a parent-side extension can prepend the SKILL.md content to every child task it brokers. |
| Cloud workers / isolation per worker | No cloud. Isolation is a git worktree: this repo's convention is `.pi/worktrees/` (`.pi/APPEND_SYSTEM.md`). `subagent_spawn` takes `cwd` and the default policy allows `workingDirectories: ["."]`, which includes `.pi/worktrees/*`. T3's `delegate_task` has `isolation: "worktree"`. | The `subagents` package "does not create worktrees or merge changes" (README). The parent (or a small tool) must `git worktree add` first. |
| Depth-3 coordinator → sub-coordinator → worker trees | `subagents`: non-recursion is an invariant ("Non-recursion: invariant, not policy", README §218). Workflows (`subagent_workflow_start`, [WORKFLOWS.md](../packages/subagents/WORKFLOWS.md)) give DAG fan-out/fan-in, checks and bounded loops without nesting. T3 children can delegate (T3 `task_cancel` stops "the tasks it delegated too"). | Orchestrate's sub-coordinator layer is not expressible under plain Pi `subagents`; express tracks as workflow definitions instead, or require T3 for that playbook. |
| Model slug detection and a budget ladder (`max > xhigh > high > medium > low`, `-fast`) | `ctx.modelRegistry.getAvailable()` lists models the user can use; `subagent_catalog` lists what children may use under the allowlist. Thinking is a per-model level in the `provider/model:thinking` triple (`splitModel` in `policy.ts`). | No "fast" speed token in Pi; drop it. Budget maps to the thinking level. Verify the exact `ThinkingLevel` enum against the installed Pi before encoding a ladder. |
| Always-applied rule file for roles | Pi has no rules directory. Options: (a) `~/.pi/agent/APPEND_SYSTEM.md` / `.pi/APPEND_SYSTEM.md` (project file wins, not merged; [docs/configuration.md](#sources)); (b) an extension reads `~/.pi/agent/pstack.json` or `.pi/pstack.json` and injects the role table through `before_agent_start` → `systemPrompt`, and exposes it as a `pstack_roles` tool. | (b) is better: machine-validated against the catalog, and a tool call is cheaper than reading a file in every skill. Note `.pi/` project files load only after project trust. |
| Custom mode (skill stays on across turns) | Extension state + `before_agent_start` (append `systemPrompt`) or `context` (inject a message). Persist the toggle with `appendEntry` so it survives reload; show it with `ui.setStatus`. | Needs an extension. A skills-only port can approximate it with `/skill:poteto-mode` each turn or a project `APPEND_SYSTEM.md`. |
| `/loop` | Extension: timer + `ctx.sendMessage({...}, {triggerTurn:true, deliverAs:"nextTurn"})`, stop on `agent_end` predicate or `/loop stop`. Or a `subagents` workflow `Loop` for child-driven loops. T3 has `schedule_task` and `watch_pull_request` for event wakes. | Needs an extension for plain Pi. |
| `AskQuestion` | `ExtensionToolContext` has `ui.select/confirm/input` (types.d.ts ~L519), so an extension can register an `ask_user` tool that is a no-op outside TUI. | Small extension tool. |
| Todo list | Not a Pi built-in. `ui.setWidget` can render one; a `todo` tool with `appendEntry` persistence is ~100 lines. | Small extension tool, or accept a markdown checklist in the reply. |
| Transcript mining (`recall`, `reflect`, `automate-me`, trail audit) | Pi sessions are JSONL under the agent dir's `sessions/` ([docs/sessions.md, session-format.md](#sources)); `ctx.sessionManager` exposes the current session path. | Rewrite path discovery; confirm per-cwd layout before shipping. Privacy rule "do not glob other projects" still applies. |
| MCP discovery for `why` | `mcp-client` package registers MCP tools; `mcp_servers_change` event; `getAllTools()`. | Rewrite the "inspect `mcps/`" step to "list tools whose namespace is an MCP server". |
| `create-skill` built-in | `agent-skills` ships `writing-for-agents` and the `lint-skill` CLI. | Point to those. |
| `deslop`, `control-ui`, `control-cli` (external) | No equivalent. `computer-use` (macOS only) and T3 `preview_*` tools cover some UI driving. | Leave as "verification skill is project-local" (pstack's own `create-verification-skill` already assumes this). |
| PR watching (`watch-pr`) | T3: `watch_pull_request` native. Plain Pi: port the script to run under `tsx` (packages already depend on it) or drop bun. | The script is ~2.5k lines with tests; porting is mechanical (`import.meta.dir` → `import.meta.dirname`, bun lock → npm). Decide whether plain-Pi babysit is in scope. |
| Orchestrate store CLI (`orch.ts`) | `subagents` workflows retain artifact/validation history and expose `subagent_workflow_inspect`; the plain-file store (`units.tsv`, `ledger.tsv`) can be workflow artifacts. | Either port `orch.ts` (bun → tsx) or re-express as workflow definitions. The plain-file idea ("every file has exactly one writer, readers aggregate at read time") is worth keeping regardless. |
| `bun` | Node 22.19 + `tsx` is the repo standard. | Replace. |

### 2.1 Overlap with `agent-skills`

`agent-skills` already ships `tdd`, `code-review`, `research`, `diagnosing-bugs`,
`writing-for-agents`, `grilling`, `domain-modeling`, `codebase-design`. pstack's
`tdd`, `interrogate` (review), `why`/`how` (investigation), `unslop`/
`technical-writing` (prose), and `sharpen`/`in-your-own-words` (clarify the ask)
cover the same ground with different rules. Shipping both sets doubles the skill
listing in every system prompt and gives the model two contradictory TDD skills.
A port should either route pstack playbooks to the existing agent-skills where
they fit (e.g. bug-fix step "write the failing test" → `/skill:tdd`), or replace.

## 3. Implementation options

### 3.1 How to source the prose: vendor and translate, or fork

`agent-skills` proves one pattern: vendor upstream as a submodule, generate a
translated overlay with `scripts/sync.sh`, fail the check on drift
([`packages/agent-skills/AGENTS.md`](../packages/agent-skills/AGENTS.md)). That
worked because upstream's Pi incompatibilities were four mechanical substitutions.

pstack is different. The Cursor coupling is semantic: every routed skill has a
paragraph about `Task` fields, slug rejection fallbacks, `readonly` stripping
MCP, and cloud environments. A sed-style transform cannot rewrite those into
`subagent_spawn` compositions. Options:

1. **Hand fork** a subset, record the upstream pin, re-diff on upstream bumps.
   Cheapest to start; drift is manual.
2. **Vendor + patch overlay**: submodule plus per-file patches applied by a
   script, with a drift check like agent-skills. Keeps attribution and makes
   upstream bumps a `git apply` exercise. More setup.
3. **Rewrite from scratch** using pstack as the design reference, with the
   mechanics in §1.2 and this repo's vocabulary (`CONTEXT.md`: Parent, Child,
   Composition, Allowlist). Cleanest fit, loses the upstream link.

Recommendation: start with (1) for a small core, decide between (2) and (3)
once the core has been used for a few weeks. pstack's own `reflect`/`correct`
skills assume you will edit the skills as you learn, which argues against a
tightly generated overlay.

### 3.2 Proposed package shape

A new package, working name `packages/playbooks` (final name per `CONTEXT.md`
naming review), in three layers so that layer 1 is useful on its own.

**Layer 1, skills only (no extension code).**

- `skills/<mode>/SKILL.md`: the router. Same structure as poteto-mode:
  non-negotiables, principle index, autonomy, delegation defaults, reply style,
  playbook table. Delegation section written against the backend-neutral
  contract from `agent-skills/skills/references/CHILD-DELEGATION.md`, with two
  concrete recipes: `subagent_spawn` (model from the role table, `tools`
  subset for read-only, `cwd` = a worktree the parent created under
  `.pi/worktrees/`) and T3 `delegate_task` (`target.model`, `isolation:
  "worktree"`).
- `skills/<mode>/playbooks/*.md`: start with investigation, bug-fix, feature,
  refactoring, prototype, opening-a-pr, autonomous-run, session-pickup,
  pause-safely. Defer babysit/shipping/orchestrate/autopilot until the
  delegation and PR-watch story is settled.
- `skills/<mode>/principles/*.md`: the 24 leaves as plain reference files
  under the mode skill, not 24 separate skills. Pi reads them by path; keeping
  them out of the skill catalog avoids 24 entries in every system prompt. If
  slash access matters, promote a few to skills with
  `disable-model-invocation: true`.
- Routed skills: `swarm`, `arena`, `interrogate`, `how`, `show-me-your-work`
  (plus its `log.sh`), `setup` (see layer 2). `why`'s MCP mapping rewritten
  against `mcp-client`.
- Role table: until layer 2 exists, a documented `~/.pi/agent/playbooks.json`
  that skills read with `read`. Shape: `{"budget":"high","roles":{"code":
  "provider/model:thinking","judgment":"…","swarm workers":"…","interrogate
  reviewers":["…","…"]}}`. Values must be exact Pi identities that the
  `subagents` allowlist permits.

**Layer 2, a small extension (`extensions/playbooks/index.ts`).**

| Piece | Pi API | Notes |
|---|---|---|
| `/playbooks-setup` | `registerCommand`; `ctx.modelRegistry.getAvailable()`; `subagent_catalog` when present; `ui.select` for budget and per-role picks; writes the JSON above | Mirrors setup-pstack steps 1–6. Validates every model against the catalog, never writes an unconfirmed id. |
| `playbooks_roles` tool | `registerTool` | Returns the resolved role table so skills call a tool instead of reading a file. Falls back to defaults when the file is absent. |
| Mode toggle `/playbooks on|off` | `registerCommand`, `appendEntry` for persistence, `before_agent_start` → `systemPrompt` append (the mode skill's non-negotiables and principle index), `ui.setStatus` | Replaces Cursor custom modes. |
| `ask_user` tool | `registerTool` with `ctx.ui.select/confirm/input`; returns "no UI" outside TUI so skills apply the default and report | Replaces `AskQuestion`. |
| `todo` tool + widget | `registerTool`, `ui.setWidget`, `appendEntry` | Replaces Cursor's todo list. Optional; markdown checklist is an acceptable MVP. |
| `decision_log` tool | `registerTool`; appends a TSV row and an `appendEntry` session record | Makes the trail readable from the session as well as the file. |
| `/loop <predicate>` | `registerCommand`; timer; `sendMessage({customType:"loop-tick"…},{triggerTurn:true, deliverAs:"nextTurn"})`; stop on `/loop stop` or when the model calls a `loop_done` tool | Replaces Cursor `/loop`. Must respect `agent_end` and not fire while a turn is running. |
| Child preamble | Wrap or advise: when the parent spawns a delegate for a playbook step, prepend the mode skill path to the task | Replaces `poteto-agent`. |

All of these are ordinary extension APIs confirmed in `types.d.ts`
(`registerTool`, `registerCommand`, `before_agent_start`, `sendMessage` with
`triggerTurn`/`deliverAs`, `appendEntry`, `ui.*`, `modelRegistry`).

**Layer 3, programs.**

- Orchestrate / autopilot as `subagents` workflow definitions: one task per
  unit, agent checks for verification on a different model family, bounded
  repair loops, deadline and concurrency set per run. The plain-file store
  becomes workflow artifacts. Under T3, the same playbook maps to
  `delegate_task` per unit and `watch_pull_request` per PR.
- `watch-pr` port to `tsx` if plain-Pi babysit is wanted.

### 3.3 Reuse of existing packages

| Package | Reuse |
|---|---|
| `subagents` | The delegation backend for plain Pi. `subagent_catalog` feeds setup; `subagent_spawn` with exact model and tools does what pstack asks of `Task`; `subagent_wait` replaces `run_in_background` polling; workflows carry layer 3. No change needed for layer 1. Possible later change: a `worktree` option on spawn (today "does not create worktrees"). |
| `durable-subagents` | Same contract, native Durable hosts. Nothing pstack-specific. |
| `agent-skills` | `writing-for-agents` + `lint-skill` stand in for `create-skill`; `tdd`/`code-review`/`research`/`diagnosing-bugs` can be routed from playbooks instead of duplicated; `references/CHILD-DELEGATION.md` is the delegation abstraction. The sync/drift pattern is a template if §3.1 option 2 is chosen. |
| `mcp-client` | Evidence sources for `why`/`recall`. |
| `claude-subscription`, other providers | Supplies the model diversity the review panels depend on. |
| `self-reload` | Already there for the "fix the broken skill mid-task" rule. |

## 4. Tensions and open questions

1. **Roles versus Composition.** `CONTEXT.md` rejects "profile, role, preset,
   template" for a Child's Composition because a fixed profile caps what the
   Parent can build. pstack is role-centric. Resolution that respects both: the
   role table is a *default lookup used by skills*, resolved into a full
   Composition at spawn time; the `subagents.json` allowlist stays the ceiling
   and setup refuses any role model outside it. Name it "role default", not
   "preset", in docs.
2. **Concurrency.** The default policy allows `maxChildren: 4`; `swarm` with
   N > 4 needs a policy change. The skill should read the limit from
   `subagent_catalog` and shape N to it rather than fail.
3. **Nesting.** Orchestrate's sub-coordinators need child-spawned children.
   Plain Pi `subagents` forbids that by design. Either keep orchestrate
   T3-only, or restate it as workflows (preferred; see §3.2 layer 3).
4. **Skill catalog size.** 55 skill descriptions in every system prompt would
   be a real cost, but Pi's `formatSkillsForPrompt` (`dist/core/skills.js`)
   omits skills with `disable-model-invocation: true`, and pstack already sets
   that on every workflow skill. So the only entries that must stay visible are
   the ones the model should pick on its own. Keep principles as references,
   keep the flag on routed skills, and measure with `getContextUsage()`.
5. **Thinking ladder.** pstack's `max/xhigh/high/medium/low` plus `-fast` does
   not map one-to-one onto Pi thinking levels across providers. Setup must
   derive the ladder from each model's `thinkingLevels` (`LocalModel` in
   `policy.ts`) rather than hard-code tokens.
6. **Transcript access.** Three skills mine prior sessions. Pi session file
   layout and the privacy boundary (only this project's sessions) need to be
   pinned before those skills ship. `ctx.sessionManager.getSessionFile()` and
   `getSessionDir()` (`ReadonlySessionManager` in `session-manager.d.ts`) give
   an extension the current session's path to hand to those skills.
7. **T3 duplication.** Inside T3 Code, `delegate_task`, `watch_pull_request`,
   `schedule_task` and `preview_*` already cover `Task`, babysit, `/loop` and
   UI verification. Layer 2's `/loop` and `ask_user` should stay inactive when
   `T3_MCP_URL` is set, the same way `subagents` does.
8. **Overlap with agent-skills** (§2.1): decide route-or-replace per skill
   before writing playbooks, so the playbooks name one skill per step.
9. **Licensing and attribution.** MIT; keep the upstream LICENSE and pin in the
   package, as agent-skills does for its vendor.

## 5. Suggested next step

Build layer 1 only, with five playbooks and three routed skills, against the
existing `subagents` package, then run pstack's own
[eval playbook](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/skills/poteto-mode/playbooks/eval.md)
(blinded judge on a different model family) on a real task with and without
the mode skill. That answers whether the routing-plus-principles structure
earns its context cost on Pi before any extension code is written.

## Sources

- pstack at `e5136d82418d2db3165ea1050d17577cd618cc05`: files linked inline;
  read from a sparse clone of `https://github.com/cursor/plugins`.
- Pi 0.99.2 docs, from `packages/subagents/node_modules/@earendil-works/pi-coding-agent/docs/`:
  `skills.md` (skill commands, `disable-model-invocation`, argument appending),
  `slash-commands.md` (`/skill:name`), `prompt-templates.md`,
  `configuration.md` (`SYSTEM.md`, `APPEND_SYSTEM.md`, `.pi/` layout, trust),
  `settings.md` (`enableSkillCommands`), `packages.md`, `sessions.md`,
  `session-format.md`, `extensions.md`.
- Pi 0.99.2 extension types: `dist/core/extensions/types.d.ts` (`ExtensionAPI.on`
  events incl. `before_agent_start`, `context`, `agent_end`, `model_select`,
  `mcp_servers_change`; `registerTool`, `registerCommand`, `sendMessage`
  options `triggerTurn`/`deliverAs`, `sendUserMessage`, `appendEntry`,
  `ExtensionUIContext`, `ToolDefinition`, `ResourcesDiscoverResult`,
  `BeforeAgentStartEventResult`); `dist/core/skills.d.ts` (`SkillFrontmatter`,
  `disableModelInvocation`); `dist/core/model-registry.d.ts` (`getAvailable`).
- This repo: `packages/subagents/README.md` (tools table, non-recursion,
  workflows), `packages/subagents/extensions/subagents/src/policy.ts`
  (`DEFAULT_POLICY`, `splitModel`), `packages/subagents/WORKFLOWS.md`,
  `packages/durable-subagents/README.md` (host API),
  `packages/agent-skills/AGENTS.md` (vendor/translate pattern),
  `CONTEXT.md` (vocabulary), `.pi/APPEND_SYSTEM.md` (worktree convention),
  `docs/t3-subagents-revamp.md` (T3 bridge behaviour).
