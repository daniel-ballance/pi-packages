# p3stack review backlog

What is left from the November 2026 review of p3stack and t3-agent. The review's other findings are fixed.

## Decided

- On 2026-11-24 the owner chose 46 invocable skills: move 43 procedures (including the 24 principles) under their owners as references and drop the three remaining entries.
- With routing off, deep-module prompts no longer select a skill; `tdd`, `architect` and `improve-codebase-architecture` link the `codebase-design` reference.
- Multi-PR plans keep their ten mandatory live verification lanes per PR. The owner chose to leave the template and `check-plan.mjs` as they are (2026-11-24).
- The live evals ran on this branch on 2026-11-24 (results in [the eval decision log](evals/README.md#decision-log)). Still unmeasured: routing on the parent models the owner uses day to day, and anything under T3 Code. The runs used `gpt-6-luna` at low and medium thinking in a terminal.
- A supervised T3 delegation is not capped at the 4,000 characters the approval dialog shows. The brief is sent whole; a call longer than the preview must put `task` last, so the other arguments stay in view (2026-11-24).
- `ask_user` has no deadline unless `P3STACK_ASK_TIMEOUT_MS` is set. T3 holds a question open until the person answers (2026-11-24).
- A parent declares seven subagent tools: catalog, spawn, send, read, wait, close and respond. The others are found by tool search or activated through `subagent_catalog` (2026-11-24).
- `extra/` and `authored/` stay separate. `authored/` holds owned skills, which the registry and the model-name lint check; `extra/` holds resources added to upstream skills.
- Terminal sessions start with `tool_search` on (`defaultTools` in `global/settings.json`). T3's bridge already turned it on for its sessions.
- Every routed row keeps its poteto-mode read. The one router version that stated the read once, above the table, routed 11% of runs as expected (2026-11-24).
- T3's `standard` loadout stays the default until someone counts the searches it saves in real sessions (2026-11-24).
- No routed migration procedure is added for externally consumed or persisted data (2026-11-24).
- The Pi crash below is not reported upstream (2026-11-24).
- T3 Code 0.1.9 builds the composer's `/` menu from `pi --mode rpc --no-session --offline`, started without `T3_MCP_URL`. Without help, that menu had none of the six `/t3-*` shortcuts. t3-agent now recognises that launch by its arguments and T3's `T3CODE_*` environment and names only its skill, its prompts and `/t3-agent` there (2026-11-24).

## Measured and left

Each measurement used a scripted stand-in model. It shows what one reminder costs, not how often a real model triggers it.

- Todo settle reminders: 3 extra provider calls in 13 across three runs. Two reconciled a finished file write and one was redundant. The safeguard stays.
- The preview-tab reminder: 3 extra provider calls across four cases. One corrected a missed close and one was redundant. The safeguard stays.
Real sessions, counted on 2026-11-24 across the 469 Pi session files on the owner's machine (1–24 November, terminal and T3, parents and delegates, 1,155 user messages):

- **Todo mid-run reminder** (after four turns without `todo` while items are open): 1,148 reminders in 261 sessions, at most one per run. It adds no provider call; it rides on the turn. The next `todo` call came within one turn after 100 of them (9%), within five turns after 342 (30%), and six or more turns later after 755. In 51 runs the list was never touched again. By the end of the run, 627 had items marked done or skipped. The reminder rarely changes what the model does next.
- **Todo settle reminder:** 21 in the same period, costing 35 extra provider calls. Two marked an item done. Fourteen wrote a visible reply despite the instruction to end silently, most often restating that delegated work was still running. The rest re-marked items pending or in progress with a note.
- **Preview-tab reminder:** never fired. No session opened a T3 preview tab; the only preview calls were six `html_preview` renders.

The settle reminder costs more than it returns when the open items wait on delegates or the user. Changing either todo reminder is the owner's call.

- The stock footer: Pi 1.5.2 has no supported way to decorate it, so the copied renderer stays. `src/footer.ts` records what was checked.
- Held-out paraphrases select the intended skill at rank 1 in 7 of 17 cases, against 49 of 51 on the examples the descriptions were written against. The number is reported by `npm run check` and fails nothing.

## Open

- Trial shorter descriptions for the model-invoked skills, and check discovery with routing off before making any skill explicit-only. The owner agreed to the trial on 2026-11-24.
- Make nightly maintenance report the sources whose upstream moved and open a pull request only when asked. The owner agreed on 2026-11-24. The T3 schedule and `maintain-p3stack`'s nightly reference still bump and land every changed tip.
- Report to Pi that 1.5.2 does not activate a deferred tool first registered at `session_start` when it is named with `--tools +name`. The subagents catalog does not depend on it.

## A Pi crash found during this work

A rejected `Promise.all` in a codemode script could end the Pi process. The cause is in Pi 1.5.2's built-in `read` tool, not in this repository or in T3: when the script ends, Pi cancels its pending calls, and a `read` cancelled at that moment opens its file stream with an already-aborted signal. The stream's error event has no handler. One existing file and one missing path reproduce it with no extensions loaded.

No guard was added here. An extension cannot reach that stream, and a process-wide error handler would hide other failures. Scripts that batch tool calls use `Promise.allSettled` until Pi is fixed. The issue text, with a self-contained reproduction, is [drafted](upstream/pi-read-cancel-crash.md); the owner chose not to file it.
