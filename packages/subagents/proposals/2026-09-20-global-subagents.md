# Proposed global subagent policy — 2026-09-20

**Proposal only.** Intended destination: `~/.pi/agent/subagents.json`. That file and the launch project's `.pi/subagents.json` were absent during inspection, so this parent currently uses built-in policy. Nothing in the active user configuration has been changed.

Companion complete JSON: [2026-09-20-global-subagents.json](2026-09-20-global-subagents.json).

Process: the bundled [subagents skill](../skills/subagents/SKILL.md) and its [three-source research reference](../skills/subagents/reference/model-research.md). User goals: use both ChatGPT Pro and SuperGrok, keep a small useful menu, and prefer sensible model changes over blindly increasing reasoning effort. Explicit exclusions and the restriction to GPT-5.6 among OpenAI models were respected.

## Recommendation: five combinations, three model families, two providers

| Exact Pi selection | Initial purpose | Escalation / alternate path |
|---|---|---|
| `openai-codex/gpt-5.6-luna:high` | Bounded exploration, grounded summaries, test triage, small well-specified changes | Choose Luna xhigh for bounded implementation or Sol high for substantially interacting constraints |
| `openai-codex/gpt-5.6-luna:xhigh` | **User-preferred** bounded implementation, detailed investigation and scoped debugging | Choose directly when appropriate; Sol high for broader/interacting work, not automatic Luna max |
| `openai-codex/gpt-5.6-sol:high` | Primary implementation, difficult debugging, substantial multi-file changes | Reframe/check the problem or seek Grok review before automatically raising effort |
| `xai/grok-4.6:medium` | Efficient second-provider engineering/investigation/review candidate | Grok high for ambiguous multi-file work where extra reasoning proves useful |
| `xai/grok-4.6:high` | Demanding cross-provider review and ambiguous engineering tasks | Verify findings; don't treat another provider's agreement as proof |

These are recommendations, not enforced profiles or an automatic router. All models share the policy's tool/resource permissions; each spawn still selects a subset.

**Why Luna high rather than also including medium?** Choose one reasonably capable exploration rung initially. Luna's medium→high improvement is substantial in the two engineering suites below, unlike Sol's relatively small high→xhigh increment. High is a conservative starting point for imperfectly specified repository tasks. That is an inference—not a claim that these benchmarks directly test summaries or that medium is inadequate for factual lookup. Medium remains a reasonable later substitution if local measurements show quicker bounded work without quality loss. No need to include every level now.

**Why keep Luna xhigh?** The user explicitly reports strongly positive practical experience and requests it as an exception to the general above-high rule. That experience changes the initial benchmark-only proposal: Luna xhigh is a preferred bounded-implementation option, not a fallback to be grudgingly avoided. This is user-reported experience, not a newly measured local comparative win rate. It can be chosen directly without trying high first. Treat the public timing comparisons below as task-distribution evidence, not a reason to overrule demonstrated personal utility.

Grok medium/high is the other within-model choice because the two engineering sources disagree meaningfully about that tradeoff. It gives SuperGrok a useful default and escalation rung without exposing every setting.

No default `max` entries, and no `xhigh` outside the explicit Luna exception. A future Sol xhigh entry could be justified by repeated failures that additional reasoning actually resolves; it should not be the reflexive next step after any unsuccessful run. More tokens cannot fix an underspecified task or missing evidence.

## Availability and deployment evidence

Inspected Pi **0.85.1** using `pi --offline --list-models` and the new `scripts/model-inventory.mjs`. After the user's scope restrictions, the six available candidates are:

- OpenAI Codex: `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`.
- xAI: `grok-4.3`, `grok-4.5`, `grok-4.6`.

The registry reports OAuth/subscription routing for both providers, consistent with the user's ChatGPT Pro and SuperGrok subscriptions. All five proposed exact thinking selections are supported locally. Pi currently advertises 272,000-token context for these OpenAI models and 200,000 for these xAI models. Broader advertised benchmark/provider context windows must not be silently substituted for those local limits.

Availability means registered/configured, **not** a new successful inference test. No billable model trials were run for this proposal. Existing Luna smoke tests establish basic Pi operation/persistence, not comparative engineering quality. Benchmarks use different harnesses and generally API endpoints; their scores and timings are not measurements of these subscription routes inside Pi.

## Evidence table: configurations that inform the proposed menu

All pages accessed **2026-09-20**. Each column retains its own task suite; do not compare a percentage across columns as if it were the same test. AA is the current **Intelligence Index v4.3.2**; DeepSWE is **v1.1**; CursorBench is **4.0**.

| Model / effort | AA index | DeepSWE pass@1 | DeepSWE median time | CursorBench correctness | Cursor steps/task |
|---|---:|---:|---:|---:|---:|
| Luna medium | 25 | 11.3% ±0.8 pp | 2.5 min | 22.2% | 32 |
| **Luna high** | **32** | **44.2% ±2.9 pp** | **6.6 min** | **29.4%** | **64** |
| **Luna xhigh** | **35** | **56.9% ±2.2 pp** | **10.1 min** | **33.0%** | **98** |
| **Sol high** | **42** | **69.4% ±1.4 pp** | **8.6 min** | **35.7%** | **41** |
| **Grok 4.6 medium** | **43** | **67.5% ±2.3 pp** | **14.3 min** | **36.1%** | **40** |
| **Grok 4.6 high** | **44** | **65.2% ±1.5 pp** | **17.2 min** | **40.4%** | **48** |

DeepSWE's figures are attempt pass rates over scored attempts, not best-of-four success. Its artifact reports four repeats and 95% run-to-run confidence half-widths; context-window failures and agent timeouts count as failures, while provider/verifier/network errors are excluded. All listed DeepSWE configurations use `mini-swe-agent`. Timings are benchmark-specific medians across scored attempts, not time-to-success guarantees. Cursor steps are not measured latency. AA/DeepSWE/ Cursor numbers are rounded as published or to one decimal here; tiny gaps do not justify confident ordering.

**Triangulation:** Sol high and Grok medium are broadly strong alternatives across the three sources. Grok high improves the published Cursor score but not the DeepSWE point estimate; the DeepSWE intervals overlap. That argues for a task-sensitive branch, not a universal claim that medium is better or that higher reasoning always wins. Luna is a bounded-work choice, not the proposed long-horizon engineering default.

## Terra and maximum effort: useful pushback, not a blanket dismissal

| Configuration | DeepSWE pass@1 | Median time | Mean output tokens | Cursor correctness | Cursor steps/task |
|---|---:|---:|---:|---:|---:|
| Sol high | 69.4% ±1.4 pp | 8.6 min | 28.5k | 35.7% | 41 |
| Terra xhigh | 60.2% ±2.1 pp | 8.5 min | 39.6k | 33.6% | 43 |
| Terra max | 69.6% ±2.6 pp | 15.5 min | 71.9k | 41.3% | 107 |
| Sol xhigh | 70.7% ±0.8 pp | 11.6 min | 40.7k | 37.7% | 55 |
| Sol max | 72.7% ±2.8 pp | 16.9 min | 60.0k | 41.7% | 99 |

The user's **Sol high rather than Terra xhigh** hypothesis is well supported by these particular engineering measurements. Terra max is **not strictly dominated**: it is meaningfully higher on the published Cursor correctness score, albeit with substantially more steps, and approximately tied on DeepSWE while taking much longer. AA also scores Terra max at 42, the same as Sol high. Excluding Terra initially is a practical menu/latency decision, not proof it has no useful niche.

Sol high→xhigh adds only 1.3 percentage points on DeepSWE while median time rises roughly 34%; high→max roughly doubles median time for 3.3 points. Cursor does show some extra correctness at higher efforts, so the gains are not zero. Keep them out of the default menu unless local accepted-result outcomes justify the cost in time and subscription capacity.

Luna's high→xhigh→max gains on DeepSWE are larger (44.2→56.9→67.2%), so a blanket “more reasoning never pays” would be wrong. But its xhigh/max benchmark medians are 10.1/16.4 minutes, versus Sol high's 8.6 minutes at 69.4%. With both accessible through the same subscription, this supports **considering a model switch** for hard work rather than exhausting Luna's effort settings. It does not invalidate the user's positive Luna xhigh experience on their own bounded tasks, which is why that configuration remains in the proposal. These timings are not measured on the user's machine/provider route.

## Other in-scope candidates

- **Grok 4.5 high:** AA 39; DeepSWE 53.8% ±2.3 pp. No matching entry in the current CursorBench 4.0 table inspected. DeepSWE's median is 7.2 minutes, lower than Grok 4.6 medium, so it is not universally dominated on every axis. Nevertheless, the weaker success evidence and redundant role do not justify another initial menu entry. Revisit only if actual short-task latency or subscription behavior supplies a distinct advantage.
- **Grok 4.3 high:** AA 25. No matching row in the current DeepSWE v1.1 data or CursorBench 4.0 table inspected. Missing evidence is not a zero score. Its lower listed API prices do not establish a useful advantage for this subscription-first setup; don't add it without a concrete locally demonstrated role.
- **Terra:** discussed above; hold in reserve rather than offering a model at every price tier.

## Cost, provenance and uncertainty

The user pays for subscriptions. Public API-equivalent dollars are **not marginal cash bills or known subscription-quota weights**. Favor accepted-result quality, elapsed time, review burden and practical provider availability. We have not measured quota conversion, rate limits or concurrent capacity for these exact routes.

Two source issues reinforce this caution:

1. AA's July GPT-5.6 launch article uses an older index and older prices. The current model pages explicitly use v4.3.2. Do not mix the launch scores into this table. AA's Coding Agent Index also incorporates DeepSWE, so counting that plus DeepSWE as independent corroboration would double-count evidence; this proposal uses AA's Intelligence Index column instead.
2. DeepSWE's downloadable artifact and rendered page expose different dollar costs for some GPT-5.6 entries (for example Luna max: approximately $3.03 in the artifact versus $0.61 on the page), while the score/token/timing data agree for the configurations compared. Repricing is a plausible explanation, not something to silently assume. Likewise, the current AA Sol page lists $4/$20 per million input/output tokens while the inspected Pi registry lists $5/$30. No provider metadata was changed. We avoid deriving an exact dollar budget from these mixed cost bases.

This is a **benchmark-informed initial policy**, not a local validated Pareto frontier. Provider/harness effects, suite selection, changing aliases and subscriptions can change the practical order. Cross-provider review offers another perspective, not statistically independent assurance.

## Configuration choices beyond models

The companion JSON preserves the existing built-in tool/resource/prompt permissions, four-live-child cap and launch-directory root. Five permitted model/effort choices do not require five simultaneous children. It changes the model menu/guidance, not the security model:

- Core tools remain permitted, but each spawn should request only what it needs.
- No extra extensions/skills/themes/templates are granted to children. The bundled management skill is parent-side.
- System prompt replacement/appending and normal context-file discovery remain permitted.
- `workingDirectories: ["."]` follows each parent's launch cwd, not the global config directory. Bash and file tools are not sandboxed by this setting.
- No automatic routing, budget enforcement or per-provider cap is implied by model descriptions.

If later approved: back up any policy that has appeared in the meantime, write the complete JSON to the intended global path, warn about live children, reload affected parents and inspect the catalog. A trusted project override still wins as a whole file.

## Local calibration before claiming a winner

Run only with approval and a stated budget, using disposable identical repository snapshots:

1. Compare Luna high against current Luna medium on a few real exploration/summary/triage tasks: references, omissions, unsupported assertions and latency. Keep high only if its extra effort is useful.
2. Compare user-preferred Luna xhigh, Sol high and Grok medium on matched debugging and small implementation tasks, using independent behavioral/regression tests and patch review. Preserve Luna xhigh's useful role unless relevant experience warrants changing it.
3. Compare Grok medium/high on a deliberately ambiguous multi-file task. Record clarification quality, false positives, interventions and accepted outcome—not merely output length.
4. Include tool denial, cancellation and persistent follow-up tests to expose adapter/harness issues separately from model quality.
5. Record elapsed time, attempts, tests, human corrections, usage deltas and provider availability. Repeat enough to expose variation within the approved budget; don't claim statistical certainty from a handful of successes.

Then narrow descriptions using observed strengths/failures. Add a higher-effort Sol or Terra entry only if a representative unresolved task shows a benefit. Explicitly close trial children after reading results.

## Primary sources and reproducibility

Reviewed full page text or relevant methodology/data sections, not just search snippets:

- [AA methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking), [inference methodology](https://artificialanalysis.ai/methodology).
- AA model profiles: [Luna medium](https://artificialanalysis.ai/models/gpt-5-6-luna-medium), [Luna high](https://artificialanalysis.ai/models/gpt-5-6-luna-high), [Luna xhigh](https://artificialanalysis.ai/models/gpt-5-6-luna-xhigh), [Luna max](https://artificialanalysis.ai/models/gpt-5-6-luna), [Sol high](https://artificialanalysis.ai/models/gpt-5-6-sol-high), [Sol max](https://artificialanalysis.ai/models/gpt-5-6-sol), [Terra max](https://artificialanalysis.ai/models/gpt-5-6-terra), [Grok 4.6 medium](https://artificialanalysis.ai/models/grok-4-6-medium), [Grok 4.6 high](https://artificialanalysis.ai/models/grok-4-6), [Grok 4.6 xhigh](https://artificialanalysis.ai/models/grok-4-6-xhigh), [Grok 4.5 high](https://artificialanalysis.ai/models/grok-4-5), [Grok 4.3 high](https://artificialanalysis.ai/models/grok-4-3).
- [AA July launch article](https://artificialanalysis.ai/articles/gpt-5-6-has-landed), used to identify version overlap and the inclusion of DeepSWE in its Coding Agent Index, **not** for the current score table.
- [DeepSWE leaderboard](https://deepswe.datacurve.ai/), [v1.1 data artifact](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json) (generated 2026-09-03), [methodology/limitations](https://deepswe.datacurve.ai/blog/deepswe), [repository](https://github.com/datacurve-ai/deep-swe).
- [CursorBench 4.0](https://cursor.com/cursorbench), [methodology article](https://cursor.com/blog/cursorbench). The older article references older suite versions; only the current leaderboard supplied this proposal's scores.

Use the bundled [research scripts](../skills/subagents/scripts/README.md) to refresh the inventory and source snapshots. Preserve their manifests outside the package. Snapshot extraction does not execute page scripts; DeepSWE's public data-artifact URL was found in the page source. Public facts are summarized here; raw downloaded pages remain outside the repository. No credentials or private source code were sent to research sites.
