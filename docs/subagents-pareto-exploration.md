# Subscription-model Pareto exploration

Date: 2026-09-27. Status: exploratory; no model recommendations or policy changes yet.

## Goal

Use Artificial Analysis (AA) Intelligence Index versus cost to inform the subagents package's default model allowlist, initially scoped to the maintainer's authenticated hosted subscription models. Keep analysis separate from policy generation and approval.

## Observations

### Local inventory

Existing helper: `packages/subagents/skills/subagents/scripts/model-inventory.mjs`.
It emits sanitized availability, subscription/OAuth flags, thinking mappings and registry prices without inference calls. It does not load session extensions or restrict itself to the current subagent allowlist.

On this machine, the helper resolved Pi SDK 0.85.1 and reported 14 subscription models. The installed `pi --version` is 0.87.1; `pi --offline --list-models` listed 12 matching subscription models:

- `openai-codex`: `gpt-5.3-codex-spark`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`.
- `xai`: `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-4.7`.

The older SDK additionally listed `openai-codex/gpt-5.4` and `openai-codex/gpt-5.4-mini`. Do not silently union these inventories. Resolve the discrepancy using the actual target runtime before ranking candidates or emitting exact thinking combinations. Local/non-subscription models are outside scope. Configured authentication does not prove remote entitlement or a successful request.

Temporary sanitized inventory: `/tmp/pi-pareto-inventory.json`. These temporary files are not durable repository evidence.

### AA data access

Primary sources read:

- [API overview](https://artificialanalysis.ai/data-api).
- [API reference](https://artificialanalysis.ai/data-api/docs), especially Free language models, versioning and licensing.
- [General methodology](https://artificialanalysis.ai/methodology), especially price and cost definitions.
- [Intelligence methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking), introductory index definition and general testing parameters.

The endpoint-specific reference documents `GET https://artificialanalysis.ai/api/v2/language/models/free`, authenticated with an `x-api-key` header. It is paginated and exposes:

- Stable AA identities (`id`, `slug`, `name`).
- `evaluations.artificial_analysis_intelligence_index`.
- `artificial_analysis_intelligence_index_cost.cost_per_task.total_cost`.
- Total index evaluation cost, token pricing and median performance.

These fields were initially verified from documentation. A subsequent authorized authenticated fetch is recorded below. The introductory quick-start still points at `/language/models`, but its endpoint reference says that route is Pro+; use the explicit free route for a free key.

The advertised free limit is 100 requests per 24-hour window. Respect response rate-limit headers and pagination. Null means unmeasured/not applicable, never zero.

The API reports index major.minor as a number; the methodology currently identifies v4.3.2. Patch changes can affect scores but are absent from that API version field. Save a dated methodology snapshot as well as the response.

AA defines cost per task as a benchmark-weighted API-dollar cost based on consumed input, cached and output tokens. This captures differing reasoning/output consumption, unlike unit token price. It is neither cost per successful task nor subscription quota consumption. The documented pricing basis can be first-party or median-provider pricing; preserve that distinction where exposed, otherwise mark it unknown.

AA currently defines blended token price using a 7:2:1 cache-hit/input/output ratio. Do not hardcode a remembered older blend or substitute it for cost per task.

The API overview describes free access as internal-use-only with attribution and no redistribution. Clarify applicable terms before publishing raw data, charts, or API-derived artifacts in a shipped package; do not assume that a derived policy settles the licensing question.

Temporary source snapshots/manifests: `/tmp/pi-pareto-aa-snapshot` and `/tmp/pi-pareto-aa-api-docs`.

## Agreed direction

API pricing is an acceptable proxy for subscription burn rate for this exercise. Exact quota accounting is not a prerequisite; label the cost basis clearly rather than attempting to reconstruct subscription billing.

LLMs may perform qualitative analysis and draft model descriptions. Keep arithmetic, eligibility filtering, missing-data handling and Pareto membership deterministic. LLMs can propose identity/effort mappings, flag ambiguities and explain tradeoffs, but must not invent scores, silently resolve uncertain mappings or turn broad benchmark scores into demonstrated task-specific strengths.

## Proposed experiment

1. **Freeze inventory:** collect sanitized metadata with the target Pi runtime; explicitly select hosted subscription routes, excluding local and API-key-only routes. Record runtime/catalog dates and discrepancies. OAuth alone is not the eligibility definition.
2. **Freeze AA evidence:** fetch every page through the documented API with a user-provisioned key kept outside the repo/logs. Preserve private raw responses, hashes, retrieval times and methodology/version metadata. Reject incomplete/inconsistent snapshots rather than declaring a complete frontier.
3. **Review identity mapping:** map exact Pi `provider/model:thinking` to AA evaluation identity, checkpoint and effort. No fuzzy auto-acceptance, score inheritance between thinking levels, or assumed equivalence of subscription/API deployments. Record reviewed mappings and unresolved candidates separately.
4. **Compute the measured frontier:** maximize Intelligence Index, minimize AA USD/task. A dominates B iff its score is at least B's and its cost no greater, with at least one strict improvement. Retain exact ties. Missing metrics or unresolved mappings are unranked, not dominated. Use full available precision rather than chart-rounded values.
5. **Explain results:** emit a table and scatter plot with frontier points, dominated points and their dominators, coverage counts, unranked candidates and mismatch notes. A log-cost axis is useful for positive costs. The connecting line is visual guidance, not evidence for achievable intermediate configurations.
6. **Check robustness:** separately compare token-price scenarios (input-heavy, output-heavy, cache-heavy) where sufficient data exists. Flag small score gaps and sensitivity to assumptions; do not invent per-model confidence intervals. Consider per-provider frontiers for independently exhausted subscription pools, explicitly separate from the global frontier.
7. **Discuss policy:** let an LLM interpret the computed report and propose a small useful subset with concise descriptions, using explicit evidence and uncertainty. Provider fallback, latency, context and practical coding evidence may justify exceptions; label them as exceptions rather than altering the mathematical frontier. Broader DeepSWE/CursorBench evidence and bounded Pi trials can validate roles later without changing this initial two-axis question.
8. **Codify only after approval:** generate a proposed models-only diff and dated rationale. Keep tool/resource permissions unchanged, validate with the policy parser, and review before release. No automatic policy writes, reloads, inference tests or provider changes.

## Marginal returns within the frontier

Pareto membership means nondominated, not worth the upgrade. Sort the frontier by increasing cost and report each adjacent transition, plus same-model reasoning-effort transitions and comparisons from the current default to all stronger candidates. Same-model transitions may skip intervening frontier points; label them separately.

For an upgrade A to B with positive costs and strictly increasing score/cost:

- Intelligence gain: `delta_I = I_B - I_A`, in index points, not percent intelligence or success probability.
- Absolute cost increase: `delta_C = C_B - C_A`, in AA USD/task.
- Cost multiplier: `r = C_B / C_A`; percentage increase is `100 * (r - 1)`.
- Marginal cost per index point: `delta_C / delta_I`. Lower buys index gains more cheaply in absolute dollars.
- Index points per cost doubling: `delta_I / log2(r)`. Higher buys larger gains relative to the starting cost. This is a finite-difference summary, not a prediction that another doubling would deliver the same gain.

Retain both absolute and relative cost views. A large relative increase can be negligible in dollars at the cheap end; a modest percentage can be expensive at the premium end. Handle ties, zero costs and missing values separately rather than dividing by zero or manufacturing ratios.

Do not optimize `Intelligence Index / cost` or percentage intelligence gains as though the index were a ratio-scale measure of task utility. Its point increments are a useful descriptive signal, not a demonstrated economic return. Very small gains need an uncertainty warning; do not invent per-model error bars from AA's general methodology statement.

For curating defaults, prefer transparent budget envelopes over a single universal knee: for each chosen budget, report the highest measured score attainable and the cheaper alternatives within an explicitly chosen index-point tolerance. Sweep tolerances as policy sensitivity, not as claims of statistical equivalence. Thresholds and budget tiers remain to be agreed.

Avoid greedy pruning based only on the next frontier step: a weak intermediate step can precede a worthwhile larger upgrade. Evaluate all stronger candidates from each proposed default. LLM interpretation can then recommend retaining, skipping or reserving points for exceptional tasks, with arithmetic and uncertainty supplied by the deterministic report. There is no universal ban on `max`; judge each model/effort pair separately.

## Testing the model-up / effort-down heuristic

User hypothesis: when a model at `xhigh` is insufficient, prefer the next capability tier at `high` over the original model at `max`. Treat model ladders as explicit reviewed inputs (for example, GPT-6 Luna → Sol → Astra), not an ordering inferred automatically from names or parameter counts.

For each ladder edge, compare three configurations: current model `xhigh` (baseline), current model `max`, next model `high`. Also inspect next-model `medium` where measured so the heuristic does not hide a better crossover. Report absolute score/cost, gain and incremental cost from the common baseline, and direct dominance between upgrade destinations. Separate choosing an initial configuration from escalation after a failed attempt; prior failed-attempt costs are already spent.

Classify results as: direct support (next-model lower effort dominates), quality-for-premium tradeoff, counterexample (original-model higher effort dominates), or inconclusive/missing. Small score gaps require caution even when the cost difference is substantial. Restrict production recommendations to current eligible candidates; older-generation pairs can illustrate the hypothesis without reintroducing globally dominated defaults.

Aggregate AA scores cannot establish the probability that an upgrade solves a task conditional on the baseline failing. A later authorized calibration should run both upgrades on the same independently verified baseline-failure cases, with matched starting context, and compare rescue rate, additional cost, latency and intervention. Do not treat a higher aggregate index as proof of better rescue performance.

## Working subagent ceiling and shortlist

The user normally drives the parent with Astra and prefers not to spend Astra-level resources on subagents. Keep Astra in the full analysis, but provisionally cap the default subagent shortlist at Sol:

`GPT-6 Luna:medium → GPT-6 Luna:max → GPT-6 Sol:high → GPT-6 Sol:max`

All four use the `openai-codex` route. This is a proposed menu, not a mandatory sequential retry chain, and no policy change has been made. Work that exceeds the subagent ceiling should return findings and limitations to the parent rather than silently granting itself a more expensive model.

The analysis tool should report both the full eligible frontier and a recomputed frontier under the selected subagent constraints. Apply the agreed marginal-return and model-up/effort-down heuristics as advisory guidance, with evidence-backed exceptions explained explicitly. Keep selection constraints distinct from mathematical dominance.

In this snapshot all nine xAI configurations with complete score/cost-per-task data are dominated, including when Astra is excluded. This is not a rejection of all Grok configurations: two matched Grok efforts lack task-cost data and other efforts are unmatched. The separate blended-token-price frontier includes Grok. Provider diversity, separate subscription capacity, task-specific strengths or observed Pi outcomes could justify retaining a Grok option as an explicit exception; the current two-axis task-cost evidence alone does not.

## Subscription-pool-aware proposal

The user identified independently depleted OpenAI and Grok subscription pools. Global cost-per-task dominance should therefore not be the sole admission criterion. Preserve the global report, but also compute frontiers independently within each eligible subscription pool, with the Astra subagent ceiling applied to the OpenAI view. Do not assume provider and pool are universally synonymous; these are the two pools identified for this deployment.

For the current provisional mappings, the OpenAI frontier excluding Astra has 11 measured points; the Grok frontier has eight. The proposed compact menu is deliberately smaller:

- OpenAI: `openai-codex/gpt-6-luna:medium`, `openai-codex/gpt-6-luna:max`, `openai-codex/gpt-6-sol:high`, `openai-codex/gpt-6-sol:max`.
- Grok: `xai/grok-4.6:low`, `xai/grok-4.6:high`, `xai/grok-4.7:high`.

This seven-entry proposal is not the complete mathematical frontier or a claim of equivalent capability across corresponding slots. Grok 4.3 offers cheaper but lower-scoring measured options; Grok 4.5 high and Grok 4.6 medium remain legitimate intermediate frontier points. Their omission is a simplicity choice to revisit through usage. Grok 4.7 xhigh offers a very small measured gain for a substantial premium and is omitted provisionally. Grok 4.6 xhigh is dominated within its own pool.

Select a suitable pool first using current capacity preferences, then a model within it. With both pools healthy, normally prefer the global-value OpenAI shortlist. When conserving OpenAI headroom for the Astra parent, prefer Grok for tasks it can adequately handle. Begin with explicit session guidance; quota telemetry and automatic switching remain future work. Never infer remaining quota percentages from AA prices. No policy changes have been made.

## Package implications

The shipped fallback currently lives in `packages/subagents/src/policy.ts`, not a physical default `subagents.json`; the package README documents the equivalent JSON. Policy model entries accept exact `id` and optional advisory `description`, not benchmark metadata or executable routing rules.

Distinguish a personal frontier (this user's available subscriptions) from portable package defaults (other users may have different providers). A reproducible local report/proposal may eventually complement curated defaults, but runtime AA access is not required to enforce an ordinary allowlist.

## Decisions still needed

- API cost is accepted as a subscription-burn proxy. Choose the exact primary measure: AA benchmark cost per task (recommended for comparing reasoning efforts) versus standardized blended token price. These answer different questions and may yield different frontiers.
- Resolved: the user authorized sourcing `~/.bashrc` and using `ARTIFICIAL_ANALYSIS_API_KEY`; the API reports Free access.
- Later: how much provider diversity and how many frontier points should the bundled defaults retain?

## Authenticated first pass

With the user's authorization, sourced `~/.bashrc` and sent `ARTIFICIAL_ANALYSIS_API_KEY` only in the API authentication header. The key was not printed or saved in scripts/artifacts. The API reports **Free** access. Four paginated requests retrieved 674 records under API index version 4.3; no Pro endpoint request was necessary. Raw pages, hashes and retrieval timestamps remain in the private temporary directory `/tmp/pi-pareto-aa-data-_f67db36` (not committed).

A scratch analysis in `/tmp/pi-pareto-analyze.py` used explicit family-name mappings and exact effort labels, restricted to base models confirmed by the installed Pi CLI. This is a provisional mapping, not verification of API/subscription checkpoint equivalence or current-runtime thinking support. The source thinking metadata still comes from SDK 0.85.1.

Results:

- 51 name/effort combinations matched across 11 of the 12 subscription model identities.
- 46 matched combinations have both Intelligence Index and cost per task; five are missing cost.
- Codex Spark has no matched AA record. Unmatched effort levels and missing costs remain unranked.
- The strict cost-per-task frontier contains 16 combinations, all on the OpenAI route, with older Luna configurations retained at the low-cost end.
- A secondary blended-token-price frontier, calculated from API rates with the documented 7:2:1 cache-hit/input/output mix, contains five combinations and includes xAI. This is a separate calculation, not a returned Free API blended-price field.
- The materially different frontiers demonstrate why the choice of cost axis matters: unit pricing cannot account for differing token consumption at different reasoning efforts.
- Under the provisional cost-per-task analysis, the bundled Luna medium remains nondominated; bundled Luna xhigh is dominated by GPT-6 Luna max. These are observations for review, not an instruction to change defaults.
- Very small score differences create mathematically valid frontier points but are not necessarily meaningful capability differences. Any pruning tolerance must be an explicit policy decision, not an invisible change to dominance.

Private derived report: `/tmp/pi-pareto-aa-data-_f67db36/exploratory-analysis.json`. It includes both rankings, dominators, exact AA IDs/slugs, missing combinations and mapping caveats. Numerical API data is deliberately not copied into this potentially public repository pending licensing clarification. Temporary files are not a durable archive.

Observed: inventory evidence, public contracts, authenticated API fields and deterministic exploratory rankings. Inferred: a repeatable report-plus-LLM-interpretation process is feasible without upgrading API access. Unknown: verified effort/deployment mappings, current-runtime thinking support, subscription quota efficiency and redistribution permissions for intended public artifacts.
