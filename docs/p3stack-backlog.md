# p3stack review backlog

Open findings from the November 2026 review of p3stack and t3-agent. Each item stands on its own. The parenthesised references name sections of the seven review reports, which are not in the repository.

## Needs the owner's decision

- Decide when a route actually needs poteto-mode. Only the small-task row skips its full read today; making the read conditional elsewhere would save context but change which rules an agent sees. (router.md §2)
- Trial shorter descriptions for model-invoked skills, and decide which still need to be advertised. Check discovery with routing off before making a skill explicit-only. (catalog.md §8)
- Decide whether nightly maintenance should land every changed tip or report unconsumed changes without a PR. A read-only candidate classifier would separate finding a new commit from adopting it. (generator.md §5)
- Measure searches avoided by T3's `standard` loadout against the cost of declaring its tools before choosing `lean` as a default. (t3.md §7)
- Decide whether externally consumed or persisted data warrants a routed migration procedure. The dropped upstream skill covers consumer notice and retirement criteria that the one-wave versus expand–contract rule does not. (catalog.md §10 and “Reachability, merges and upstream admissions”)

## Decided

- On 2026-11-24 the owner chose 46 invocable skills: move 43 procedures (including the 24 principles) under their owners as references and drop the three remaining entries.
- With routing off, deep-module prompts no longer select a skill; `tdd`, `architect` and `improve-codebase-architecture` link the `codebase-design` reference.
- Multi-PR plans keep their ten mandatory live verification lanes per PR. The owner chose to leave the template and `check-plan.mjs` as they are (2026-11-24).

- The live evals ran on this branch on 2026-11-24 (results in [the eval decision log](evals/README.md#decision-log)). Still unmeasured: routing on the parent models the owner uses day to day, and anything under T3 Code. The runs used `gpt-6-luna` at low and medium thinking in a terminal.

## Larger changes worth doing

- Use the SDK's extension, command, and tool types at p3stack's boundaries instead of the local `Pi` and `Context` types. Commands cannot execute tools; the current factory type does not catch that mistake. (extension.md §8)
- Prepare a T3 brief before approval so the human sees the text the child receives. Native workflow and nested dispatch bypass the root hook; pass scope and grant there explicitly if those paths need the same protection. (t3.md §3; extension.md §3; subagents.md §8)
- Give standalone skills the same stop points as routed calls. `architect` proceeds to implementation, `tdd` requires user-confirmed seams, and `grilling` requires confirmation even when the caller asked for design only or no interview. (catalog.md §6; router.md §8)
- Reconcile `pr`, Opening a PR, and `implement-spec` on the PR body and on draft versus ready. A draft integration PR and a ready-to-review change are different deliverables. (catalog.md §6; router.md §10)
- Separate durable tracker acceptance criteria from revision-specific dispatch instructions throughout triage. Its issue brief still asks for signatures that can be stale by the time a child starts. (catalog.md §6)
- Give recovery, orchestration notes, and `show-me-your-work` one source for decisions and evidence. The execution ledger now identifies the run and reviewed commit, but the other records still ask the parent to record the same work. (router.md §9; catalog.md §7)
- Replace document-wide metadata rewrites such as `drop-paths` and the per-skill name rules with frontmatter edits driven by the registry. The checker reads the header correctly, but a rewrite can still change a fenced example. (generator.md §§4, 8)
- Own the Pi-specific setup and help text in small blocks and generate model examples from the role definitions. Preserve the upstream verification offers without maintaining a second role schema. (generator.md, “What to delete or merge” §2; router.md §10)
- Stage resource lint for all shipped skills, then remove redundant checks only where coverage matches. The staged `resources` list currently covers Pocock; the package-wide skill lint runs after generation. (generator.md, “What to delete or merge” §5)
- Check concrete script operands, code-span paths, and generated indexes from a consumer's installed skill directory. The packlist test checks Markdown links, not whether a command in a playbook resolves. (catalog.md §11; generator.md §3)
- Make the remaining behavior checks exercise the product: run above- and below-threshold coverage with the pinned Vitest, reproduce the skipped empty-list case on a grader copy, and check refund arithmetic in the prototype (successive partial approvals up to the order total). The prototype is now driven in a browser, which shows that controls change the page, not that the sums are right. (evals.md §1)
- Add a scrubbed receipt with revision, actual model and effort, prompt identity, usage, and a reviewable artifact for each live attempt. Raw transcripts and requested model names alone are poor evidence for comparing two revisions. (evals.md §§2–3)
- Add a human-only reconciliation path for a detached child with uncertain prompt acceptance. A retained slot prevents duplicate work but the Manager cannot confirm a dead process after restart. (subagents.md §1)
- Separate high-frequency usage updates from durable holds, report receipts, and wake notices. The Manager still serializes archived children in synchronous `registry.json` rewrites. Measure writes before changing the store format. (subagents.md §6)
- Move collection-wide packaging and security tests to the root and run host-neutral fixtures once. The nested subagents suite still pays twice for them; keep real loader, pnpm, and two-host runtime coverage. (subagents.md §12; evals.md §4)
- Extract the report inbox from `manager.ts` so read, wait, and wake delivery share one place to prepare a page and acknowledge it. Preserve the saved cursors and commit acknowledgements only for returned reports. (subagents.md, “Smallest behavior-preserving refactor” §1)
- Make advanced native management tools discoverable without declaring them all for ordinary delegation. Keep a usable path for parents without tool search, and keep the human stop controls. (subagents.md §5)
- Scope T3 handle receipts to the observed thread and environment. A Pi branch rewind or fork can restore an old receipt without undoing the T3 action; reconcile on request, not by polling. (t3.md §6)
- Describe the T3 contract with explicit required, direct, and optional operations rather than inferring required names from backticks. Keep live behavior checks separate from fingerprints and the doctor's inventory. (generator.md §9; t3.md §11)

## Small follow-ups

- Pin deep external reviews to the forge's head commit rather than assuming `origin/<branch>` is the PR head. The two differ on forks. (catalog.md §1)
- Test a design-only discussion, a task-only grant, and a correction after `/p3stack off` or compaction against the projected prompt. Old hidden messages persist; inspecting the latest section alone cannot show what the model sees. (extension.md §9; t3.md §10)
- Check the six `/t3-*` shortcuts in the live composer as well as at runtime. A discovery process without `T3_MCP_URL` can see a different command list; this is not a confirmed UI bug. (t3.md §8)
- Measure workspace Git reads on repeated T3 requests and refresh only facts that changed. A path under `.t3/worktrees` is not evidence of exclusive thread ownership. (t3.md §10)
- Test unanswered RPC dialogs with a deadline distinct from user dismissal. The abort signal now works, but a client that never responds can still leave a question pending. (extension.md §7)
- Measure the extra provider turns spent on todo and owned-tab settle reminders. Both safeguards remain; count actual unfinished work and redundant continuations before changing either. (extension.md §2; t3.md §5)
- Look for a supported stock-footer decoration point before extending the copied renderer. Cached rendering fixes disk access, not the cost of maintaining stock footer parity. (extension.md §6)
- Drop unconditional persona openers and repeated style or severity instructions where the caller already specifies the report. They add text without changing the evidence the reader needs. (router.md §10)
- Check borrowed claims as well as paths. In particular, reconcile the fix-loop claim with `review-stance.md` and record the `writing-skills` baseline method at its chain row so bumps flag the real owner. (catalog.md §10)
- Replace repeated registry admission reasons and unused phase or role annotations with specific reasons at decision points. Keep drop reasons and check for external consumers before removing fields. (generator.md §8; catalog.md §10)
- Merge `extra/` into `authored/` if their only distinction is copy order; keep emitted paths, host lint, and the two Bun test shims intact. (generator.md, “What to delete or merge” §1)
- Narrow the `/loop` coupling lint to invocations. Its substring match still forces an upstream compiler pass, its import, and the test adapter to use another filename. (generator.md, “What to delete or merge” §4)
- Reuse the root verification receipt for the same commit during a bump. Keep independent post-merge and live-host checks; rerunning the same static check adds no evidence. (generator.md §5)
- Update the eval guide to distinguish the credential source from each private attempt directory. On an invalid run, raw logs may be all the runner wrote; do not require `results.json` to diagnose it. (evals.md §2)
- Add held-out paraphrases, owned negative examples, and an expiry for pending description cases. Report zero-score ties separately so alphabetical order cannot look like vocabulary evidence. (evals.md §6)
- Replace assertions about exact source counts, retired files, or shell spelling with failures on bad registry or package fixtures. Those assertions make safe reorganizations expensive. (evals.md §9; subagents.md §12)
- Keep private worktree ownership details with the saved child, not just in its spawn receipt. A lost reply should not lose the branch and base needed for recovery. (subagents.md §10)
- Give the app-driver and formal verification generators distinct project-local skill names when the app and area coincide; both currently write `verify-<name>`. (catalog.md, “Reachability, merges and upstream admissions”)

- Replay pull request handles that older t3-agent sessions stored as `owner/repo#number` or as a self-hosted forge URL. They are dropped on replay now, so the ledger and prompt lose a watch T3 still holds. (final re-check, runtime R3)

- List `subagent_spawn` in the catalog only when `subagent_wait` and `subagent_read` can be selected with it, and state the rule in the subagents configuration reference. A policy that allows spawn without them offers a tool no spawn can use. (final re-check, subagents D2)
- Surface a child's provider error when it is closed or exits before its run settles. The error now waits for settlement, so an early close can lose its text. (final re-check, subagents D3)
- Test the two subagents checks that have none: the conditions that decide `workStarted: false`, and the step that advances the read cursor after a report is fully paged. (final re-check, subagents D4)
- Keep slash commands inside fenced text translated. Translation now skips fences to protect literal paths, and one rule patches the single command the plan template carries there; nothing flags the next one. (final re-check, generator D4)

- Stop translating `/name` in plain prose that is a path, such as `GET /research HTTP/1.1`. Fenced code, link destinations and HTML attributes are protected; bare prose is not. No such text exists at the current pins. (final re-check, generator F12)
- Scope what a T3 child reads to its brief: when a parent sets `Task grant:`, the child sees both that line and the header's session grant, and relies on the header's one sentence to pick. (final re-check, instructions A-M4)

## A Pi crash seen during this work

Two delegated sessions exited the moment a codemode script's `Promise.all` rejected on a missing file while its other reads were still in flight. An offline reproduction against Pi 1.5.2's codemode executor with a stand-in session did not crash. The cause is not isolated.
