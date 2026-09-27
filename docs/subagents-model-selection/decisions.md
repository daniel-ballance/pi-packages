# Subagent model-selection decisions

This is the durable qualitative decision record. Numerical AA snapshots/reports and identity maps belong in private run directories; consult applicable redistribution terms before publishing them. This file is not policy and does not establish measured task-specific model strengths.

## 2026-09-27 — initial working method

Initial status: proposal only. See the later approval below for applied changes.

- Start from authenticated hosted subscription models in the target Pi runtime. Local and API-key-only routes are out of scope.
- Use AA Intelligence Index versus AA cost per task as the initial frontier. API cost is an accepted subscription-burn proxy, not reconstructed quota accounting. Keep blended token price as a separate sensitivity view.
- Compute strict global and per-pool frontiers, then recompute under subagent constraints. Independently depleted subscription pools make globally dominated alternatives potentially useful.
- Use marginal score/cost changes to curate a small menu. Small index gains for large premiums are candidates to omit; tolerances are explicit preferences, not statistical significance claims.
- Compare increasing thinking with moving to the next capability tier at lower effort. This is a heuristic with exceptions, not a universal rule against `xhigh` or `max`.
- Reserve GPT-6 Astra for the parent in this deployment. Return blockers/evidence to the parent when a task exceeds the subagent ceiling.
- Prefer OpenAI's global-value options when both pools are healthy. When conserving OpenAI capacity for the Astra parent, prefer suitable Grok options. Start with explicit session guidance, not inferred quota balances.
- AA is a starting point. Actual accepted outcomes, rescue rate, intervention and latency can justify revising roles or keeping a benchmark-dominated model. Never let a refresh erase practical experience.

### Proposed compact menu

| Pool | Candidates |
|---|---|
| ChatGPT | `openai-codex/gpt-6-luna:medium`, `openai-codex/gpt-6-luna:max`, `openai-codex/gpt-6-sol:high`, `openai-codex/gpt-6-sol:max` |
| Grok | `xai/grok-4.6:low`, `xai/grok-4.6:high`, `xai/grok-4.7:high` |

This is a menu, not a compulsory sequence of retries or an equivalence between matching slots across pools. Intermediate frontier points were omitted for simplicity, not declared universally bad. The shortlist must be rechecked against runtime availability and reviewed AA mappings before a policy proposal is finalized.

Priority practical comparisons: Luna max versus Sol high; Sol max versus Astra high (parent rescue, not automatic subagent permission); Grok alternatives while conserving the ChatGPT pool. Benchmark scores alone cannot establish which upgrade rescues tasks on which a cheaper model failed.

### Refresh workflow

Invoke `/skill:refresh-subagent-models` from the trusted repository root after loading/reloading project skills. The skill ends with a proposal and artifact locations. Changing `.pi/subagents.json`, the personal policy or shipped `packages/subagents/src/policy.ts` requires a separate instruction.

For each later approved decision, append: date, target path, private evidence run reference, changes and reasons, contrary practical evidence, confidence/limitations and revisit triggers. Record the approval explicitly; a generated proposal is not approval.

## 2026-09-27 — approved shipped defaults and removal of project override

The user explicitly approved updating `packages/subagents/src/policy.ts` and deleting `.pi/subagents.json`. Applied the seven-option, two-pool menu above with provisional task guidance, capacity-conservation advice and evidence/testing requirements. Built-in tools, resources, prompt permissions, child cap and peer messaging settings are unchanged; Astra remains reserved for the parent.

The project override was removed. The existing personal `~/.pi/agent/subagents.json` was left untouched and takes precedence on reload, retaining its read/search-only permissions and previous model menu. Activating the shipped defaults on this workstation requires a separate decision about that global override. No automatic reload or inference trial was performed.

Revisit roles after repeated accepted outcomes, especially Luna max versus Sol high and the usefulness of Sol max. The source of benchmark evidence remains the private tooling run; this approval is not a claim of calibrated Pi task performance.

## 2026-09-27 — approved removal of personal override

The user subsequently approved removing `~/.pi/agent/subagents.json`. Both overrides are now absent; the built-in seven-option menu becomes effective after reload. Compared with the former read/search-only personal policy, the built-in policy also permits `bash`, `edit`, `write` and custom system prompts. Peer messaging remains disabled and the child cap remains four. File precedence was verified without reloading or invoking a model.

## 2026-09-27 — restored personal read/search-only permissions

The user subsequently requested restoring `~/.pi/agent/subagents.json`, retaining the new frontier menu but restoring its former permissions. The restored global file copies all seven current built-in model IDs/descriptions, with tools `read`, `grep`, `find`, `ls`; empty resource allowlists; `systemPrompt: false`, `appendSystemPrompt: true`, `contextFiles: true`; four children; launch-directory working roots; and peer messaging disabled. Parser validation confirmed exact model equality with the defaults and exact former permissions. The project override remains absent. The global file becomes effective after reload; the shipped defaults remain unchanged.

### Tooling smoke verification

The initial implementation was exercised on Pi 0.87.1 with an authenticated AA Free snapshot and reviewed mappings carried forward from the exploration. Private artifacts: `~/.local/state/pi-subagents/model-selection/implementation-smoke-0zhRml/`. This verified retrieval, runtime alignment and report generation; it did not run a model-selection trial or approve/apply the proposed menu. The old SDK-only inventory discrepancy is avoided by exporting through the selected Pi executable.
