# Frontier analysis: maintainer reference

The project-local `refresh-subagent-models` skill owns proposal/review in this repository. These helpers retrieve evidence and compute reports; they neither recommend final roles nor update policy. They are also usable independently from an installed package.

## Commands and private artifacts

Requires Node 22+. Run from the repository root for these examples; installed-package users should resolve `../scripts` relative to this reference instead. Read each command's `--help` for the current interface.

```bash
umask 077
SCRIPTS="$PWD/packages/subagents/skills/subagents/scripts"
BASE="${XDG_STATE_HOME:-$HOME/.local/state}/pi-subagents/model-selection"
mkdir -p "$BASE"
RUN="$(mktemp -d "$BASE/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
node "$SCRIPTS/model-inventory.mjs" --pi "$(command -v pi)" --out "$RUN/inventory.json"
```

`--pi` launches a short-lived, no-inference instance of that executable with an explicit exporter. It does not install or register an always-loaded extension. Automatic extensions/resources are disabled; use repeated `--extension /absolute/provider-file.ts` only for trusted provider extensions required by this deployment. Such extensions execute trusted code; this is not a sandbox. Project configuration is not implicitly approved. Availability is still not a successful entitlement test.

The exporter uses the selected Pi runtime's model and thinking metadata, verifies its version against that executable, and serializes only public fields. A mismatch/failure stops the export. The old SDK-only inventory mode remains available for research, but the frontier analyzer rejects it. Never fix a mismatch by editing the verification fields in JSON.

The AA key must already be in `ARTIFICIAL_ANALYSIS_API_KEY`. No helper reads a shell rc file, accepts the key on the command line, or prints it. The Free route contains the required index/task-cost data, even when the key belongs to a higher tier.

Read [current intelligence methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking) and set `AA_METHODOLOGY_VERSION` to its observed version (for example, `v4.3.2`, not a permanently assumed value):

```bash
node "$SCRIPTS/aa-snapshot.mjs" --out "$RUN/aa" --methodology-version "$AA_METHODOLOGY_VERSION"
python3 "$SCRIPTS/snapshot-sources.py" --out "$RUN/methodology" \
  https://artificialanalysis.ai/methodology/intelligence-benchmarking \
  https://artificialanalysis.ai/methodology
cp .pi/model-selection.json "$RUN/preferences.json"
# Optionally freeze an existing JSON policy target into "$RUN/policy.json".
# The repository has no project override by default; select the actual target explicitly.
```

AA requests are paginated, bounded and redirect-rejecting. Existing output directories/files are not reused. A failed snapshot retains successful pages and an incomplete manifest; inspect the failure and start a new run when appropriate. Do not analyze a partial collection as a complete frontier. Consult quota/reset headers before a later retry; there is no automatic retry loop.

The API's numeric index version omits patches. `--methodology-version` records the human/agent-observed patch version; it does not verify the website automatically. Keep the dated methodology snapshot alongside it. [API docs](https://artificialanalysis.ai/data-api/docs) and [cost definitions](https://artificialanalysis.ai/methodology) remain authoritative.

## Reviewed mappings

Create `$RUN/mappings.json` with this shape (example identities only):

```json
{
  "version": 1,
  "mappings": [
    {
      "piId": "provider/model:high",
      "aaId": "exact-aa-id-from-snapshot",
      "aaSlug": "exact-aa-slug",
      "aaName": "Exact AA display name (high)",
      "reviewedAt": "2026-09-27",
      "evidence": "https://artificialanalysis.ai/models/exact-aa-slug",
      "notes": "Same named checkpoint and effort; subscription/API deployment equivalence remains unverified."
    }
  ]
}
```

The mapping document is explicit, not fuzzy. The analyzer verifies ID/name/slug against the snapshot and Pi thinking support against the inventory. Changed/missing identities become unranked. Unsupported/out-of-scope mappings are reported as unused. Review dates and notes are required, but their truth is a review responsibility, not something the script can infer.

`{"version":1,"mappings":[]}` produces a coverage-only report. Reusing an AA row across aliases requires explicit review; sharing a score between genuinely different reasoning efforts is invalid evidence. Keep unresolved matches unknown. Maps and raw API-derived artifacts stay private until their intended redistribution is cleared.

## Offline analysis

```bash
node "$SCRIPTS/model-frontier.mjs" \
  --inventory "$RUN/inventory.json" \
  --aa "$RUN/aa/models.json" \
  --mappings "$RUN/mappings.json" \
  --config "$RUN/preferences.json" \
  --out "$RUN/analysis"
```

Add `--policy "$RUN/policy.json"` if you froze a JSON policy target. This option reads `models` solely to compare current choices with alternatives; it does not validate or rewrite the full policy. Use the package's `parsePolicy` when validating an actual policy proposal. For shipped TypeScript defaults, provide a reviewed models-only JSON export from `extensions/subagents/src/policy.ts` rather than the effective project policy. Do not execute arbitrary policy source to extract it.

Add `--previous /absolute/previous-run/analysis/report.json` to report added/removed combinations, changed evidence and frontier membership. Methodology or preference changes are labelled rather than interpreted as model improvements. Reports include input hashes. Preserve the frozen inputs alongside the report; hashes alone do not preserve evidence.

Output: private `report.json` and `report.md`. No scripts generate a deployable policy or write to Pi settings. No inference occurs. JSON contains full comparison detail; Markdown summarizes frontiers, marginal returns, crossovers, gaps and changes. Charts and quota telemetry are deliberately deferred.

## Preferences contract (version 1)

`model-selection.json` is **not** a `subagents.json` extension. Unknown fields are errors.

| Field | Meaning |
|---|---|
| `version` | `1` |
| `costMetric` | `"costPerTask"`; AA USD/task is the primary subscription-burn proxy |
| `subscriptionPools` | Array of `{id, providers}`; explicitly reviewed hosted subscription routes. Each provider belongs to one pool. Unassigned providers and non-subscription models are excluded. |
| `parentOnlyModels` | Exact bare `provider/model` identities. Retained in full reports, excluded from recomputed subagent views. Review new releases rather than assuming a name pattern supplies a ceiling. |
| `ladders` | Arrays of exact bare identities defining candidate tier progressions. Reports compare baseline `xhigh`, same-model `max`, next-model `medium` and `high`; missing efforts remain unknown. Progression is a preference, not a measured ordering. |
| `scoreTolerances` | Nonnegative point tolerances for sensitivity analysis, not confidence intervals |
| `budgetsUsdPerTask` | Nonnegative hypothetical AA task-cost budgets, not subscription quota or permission to spend |

For each budget/tolerance, the report finds the cheapest measured candidate within the tolerance of the best affordable score. Equal-cost choices are retained. Budgets and tolerances select no final policy automatically.

## Interpretation contract

- Strict dominance: at least as high a score, at most as high a cost, with one strict improvement. Keep exact ties. Use supplied precision; never round before comparison.
- Full versus constrained: recompute after exclusions; filtering an already-computed frontier can lose useful fallbacks. Independently compute each pool's frontier.
- Missing/null is unknown, not zero. Genuine zero cost is accepted; undefined ratios are reported as null. Invalid/negative/nonfinite consumed metrics fail analysis.
- Adjacent tradeoffs report score gain, absolute cost increase, multiplier, incremental cost/point and points per cost doubling. The latter is a finite comparison, not an extrapolation.
- Within-model comparisons include all measured effort pairs. Escalation comparisons include all stronger eligible destinations from current policy choices, so a weak intermediate step does not force greedy pruning.
- Token-price sensitivity uses `0.7 * cacheHit + 0.2 * input + 0.1 * output`, in USD/million tokens. It is explicitly calculated from Free fields, not a returned blended-price field. Missing rates remain unknown. This view includes scored rows whose task costs are absent, so its coverage can differ.
- AA task cost is neither cost per successful task nor subscription accounting. Actual quota state belongs to current session guidance or a later telemetry integration.
- Scores are index points, not percent intelligence. Narrow gaps need caution; the helper manufactures neither task-specific performance claims nor per-model error bars.
- Candidate descriptions and curated shortlists are LLM/human judgments grounded in the report and practical evidence. Explain deviations explicitly. The usual policy schema remains exact `id` plus optional `description` only.

## Reproducibility and tests

Package tests use synthetic snapshots/fake transports, with no credentials, network or inference. They cover ties, missing values, independent pools, constrained recomputation, effort crossovers, budget sensitivity, identity changes, runtime mismatch, pagination failures, private writes and refusal to overwrite. Root validation remains `./scripts/check.sh`.

Retain raw/normalized responses, manifests, inventory, methodology, preferences, reviewed mappings, current target snapshot and report in the private run directory. Review [AA access/redistribution terms](https://artificialanalysis.ai/data-api) before copying numerical artifacts into a public repository or package. Public decision notes can record the method and rationale without bundling the dataset.
