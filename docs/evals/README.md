# p3stack evals

| Tier | What a result tells you | What it does not tell you |
|---|---|---|
| [A: description lint](../../packages/p3stack/test/static-routing/) | Ranks example prompts against the names and descriptions of model-invoked skills in the registry. Checks vocabulary, competing descriptions, and which skill outranks another on a negative example. Runs offline in `npm run check`. | The score covers the examples scored, not skipped cases or all installed skills. Pi does not use this ranker. No model selects a route or does any work. |
| [B: first reads](../../packages/p3stack/test/routing-eval/) | A real terminal Pi model with the read tool opens files for a fixture prompt. The default is three attempts per prompt. At least two must read the expected sequence of skills and playbooks. | A successful read does not prove that the model read the whole file, followed the procedure, or delivered the change. This is not a T3 run. A row's reads issued as one batch count in start order. A prompt can also list reads that must not happen, which is how the small-task prompts check that poteto-mode is skipped. |
| [C: behavior](../../packages/p3stack/test/behavior-eval/) | Compares a task in fresh fixture repositories with routing on and off. Checks draw on tool calls, file contents, commands, and the final reply. | Off still has p3stack installed. An on/off score is not an old/new comparison. A matching reply or tool call does not prove the artifact works. Inspect the independent checks. The refund prototype is opened in headless Chromium and clicked through when a Chromium is on `PATH` (or named by `P3STACK_EVAL_CHROMIUM`); without one the check falls back to reading the script and says so. The browser walk shows that controls change the page and that each state appears; it does not check refund arithmetic. |

Tier B uses a run-wide `--max-reads`, raised to at least the expected sequence length for each prompt. Other reads also count toward a safety cap. Use B for changes to route selection. For what happens *after* selection, use C or test the deliverable directly.

## Run a live tier

B and C spend tokens. Agree on the model, cases, repetitions, and spend limit first. Start with the affected case. For a change to a playbook, compare the base and candidate with the same model, tools, prompt, and grant.

1. Use a disposable account or container with its own home, a trusted test checkout, and Pi on `PATH`. Do not mount your real home, writable work, or SSH agent. Start with a clean environment, including no repository-local Git variables such as `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_INDEX_FILE`. A temporary project is not a sandbox. Tier C runs agent and grader commands there.
2. From `packages/p3stack`, prepare fresh private directories **outside the checkout**:

   ```sh
   umask 077
   run=$(mktemp -d)
   mkdir "$run/routing-agent" "$run/behavior-agent"
   ```

3. Put test-only `auth.json` and `models.json` in each agent directory. Never pass a live agent directory, a symlink to one, or a directory of settings you want to keep. Tier B writes its own `settings.json`. Use a model that works with that setup. For C, supply `settings.json` with the package paths for the p3stack checkout and any tools the case needs. For source-grounding, configure web-search and the test MCP service in `mcp.json`. File presence does not verify credentials, packages, or tools.
4. Set `model` to the funded test model and thinking level. Run only the tier you need:

   ```sh
   npm run eval:routing -- --agent-dir "$run/routing-agent" --output "$run/routing" --model "$model" --only design --runs 3
   npm run eval:behavior -- --agent-dir "$run/behavior-agent" --output "$run/behavior" --model "$model" --only bug-red-first --arms on,off --runs 1
   ```

5. Check the attempt count, exit or timeout, and individual checks in `results.json`. An unavailable tool or an incomplete run is not evidence against a change. Inspect the produced work before drawing a conclusion. Keep raw JSONL and stderr private. Publish only scrubbed evidence and remove the disposable credentials after the run.

## Decision log

Record accepted **and** rejected changes here. Link the commit or PR and state the comparison, result, and decision. A failed attempt alone is not a rejected proposal. The previous log contained no rejections.

| Evidence | Result reported at that commit | Decision |
|---|---|---|
| [d981859](https://github.com/daniel-ballance/pi-packages/commit/d981859), A | Ranking 48 prompts exposed two description gaps: `pr` lacked "pull request", and `diagnosing-bugs` lacked "crash" and "root cause". | Accepted both description fixes. |
| [f527573](https://github.com/daniel-ballance/pi-packages/commit/f527573), C | On `openai-codex/gpt-6-luna:medium`, two runs per arm. Mean rubric scores (on, off): floor-review **100%, 50%**; bug-red-first **100%, 60%**; prototype-logic **100%, 100%**; source-grounding **100%, 40%**. Before the fix, review ran floor-check 0 of 2 times. Context7 answered 5 of 5 libraries in about 2 seconds and 6 of 6 official pages fetched directly. | Accepted floor-check before review, continuing work after restating the plan, versioned docs lookup, and grading skill variants from diffs and transcripts. |
| [e59e3ca](https://github.com/daniel-ballance/pi-packages/commit/e59e3ca), B | The human-judged layout prompt read `interactive-prototype` in 0 of 3 attempts before the change and 2 of 3 after. The full run passed 18/18 prompts, with 98.1% of 54 attempts routing as expected. | Accepted the selection cues in the human-judged chain and the repeated-run check. |
| [cf6e9e1](https://github.com/daniel-ballance/pi-packages/commit/cf6e9e1), B | On `openai-codex/gpt-6-luna:low`, three runs per prompt, same harness for every commit. Base `388b7fe`: 18/18 prompts, 96.3% of 54 runs. The router rewrite at `933faf9`, which stated the poteto-mode read once above the table and gave paths relative to "the skills directory": **0/18 prompts, 11.1% of runs**. The model chose the right target in 50 of 54 runs but read poteto-mode in 12, and 19 runs had a read fail on a wrongly resolved path. Naming both reads in every row, relative to the router file: 13/18, 77.8%. After also moving onboarding beside investigation, starting the full-autonomy design sentence at sharpen, and accepting a row's reads issued as one batch: **20/20 prompts, 98.3% of 60 runs**, including two new small-task prompts that fail if poteto-mode is read. | **Rejected** stating the poteto-mode read once above the route table, and paths relative to a named directory. Accepted two reads per row, relative to the router file. |
| [b6320ce](https://github.com/daniel-ballance/pi-packages/commit/b6320ce), C | On `openai-codex/gpt-6-luna:medium`, two runs per arm at `cf6e9e1`. Outcome scores (on, off): floor-review 100%, 100%; bug-red-first 100%, 100%; source-grounding **100%, 50%**. Process: floor-check ran in 2 of 2 on-runs and 0 of 2 off-runs, after a grader fix (it had not recognised a command prefixed with `GIT_OPTIONAL_LOCKS=0`); a red test before the edit in 2 of 2 on-runs and 1 of 2 off-runs. The prototype's regular-expression check disagreed with itself across runs, so it was replaced by a browser check and four kept prototypes were regraded: both on-arm pages threw an uncaught TypeError on load that the old check had passed. | Accepted the browser check as the prototype outcome. |
| [PR 130](https://github.com/daniel-ballance/pi-packages/pull/130), C | prototype-logic with the browser check, mode on: 3 of 5 runs passed before the change (2 threw on load; the agent had run the script in Node's `vm`, never the page). After adding one instruction to Drive the app (open the file in headless Chromium and read its console): 4 of 5 passed, 4 of 5 ran that command, and none threw on load. The one failure skipped the approved state. Mode off passed 5 of 5 throughout, with simpler pages. | Accepted the headless-console instruction. Mode on does not beat mode off on this case; it builds more (walkthroughs) and breaks more. |
