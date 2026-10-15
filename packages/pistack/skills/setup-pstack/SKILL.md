---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes the role defaults file that overrides the skill defaults. Use for /skill:setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write `~/.pi/agent/pistack.json`, the role defaults file that sets pistack's model per role.

## Steps

### 1. Detect available models

List the models you can delegate to from the model catalog (**Delegate** in the [host capabilities](../poteto-mode/references/host-capabilities.md)). That list is the dependable source. Record each model's exact identity and the thinking levels it offers. If you cannot list any, ask the user to paste the exact model ids they have access to. Never write a model you have not confirmed is available. The aliases `inherit-parent` and `auto` mean the parent chat's model; they are valid when that model is in the detected set (a terminal allowlist may exclude it).

### 2. Load current state

The default role-to-model mapping is the file shape shown in step 5 below. If `.pi/pistack.json` (trusted project) or `~/.pi/agent/pistack.json` already exists, read it and treat its `budget` and its role values as the current choices. Otherwise start from those defaults. A role not in step 5, such as `how critics`, is retired. Drop it.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer `ask_user` (**Ask the human**) over free text. Offer these four options with these exact labels, and name the current budget when the file records one. With no file, say that `large` matches the skill defaults.

- `unlimited — max thinking`
- `large — xhigh thinking`
- `medium — high thinking`
- `small — medium thinking`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`, `auto`). Resolve every default hint to a detected model per **Models and role defaults**. `unlimited`, `large`, `medium`, and `small` set the thinking level of every real model, panel entries included, to `max`, `xhigh`, `high`, or `medium`. If a model does not offer that level, use its highest offered level at or below the target, else mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `unlimited` puts Claude Opus 5.5 at `max`, while Grok 4.7, which tops out at `xhigh`, stays at `xhigh`. `small` puts both at `medium`.

**(c) Show the roles and confirm.** Show every role with its model, marking any model not in the detected set as needing a choice. Also list each role step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat's model) as the options. Prefer `ask_user` over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real model written must be in the detected set, with a thinking level it offers. `inherit-parent` and `auto` pass when the parent chat's model is in the detected set; otherwise mark the role as needing a choice. If a chosen model is not available, stop and ask again.

### 5. Write the file

Write `~/.pi/agent/pistack.json`, or `.pi/pistack.json` when the user wants a project-only choice. Record the budget label and its target thinking level, and one entry per role, using the same labels poteto-mode uses. Overwrite the whole file so re-runs stay idempotent. Models are exact identities per **Models and role defaults**: `provider/model:thinking` in a terminal, `<provider instance>/<model>:<thinking>` from the catalog under T3. Shape:

```json
{
  "budget": "large (xhigh)",
  "roles": {
    "feature, refactoring": "xai/grok-4.7:xhigh",
    "bug-fix": "xai/grok-4.7:xhigh",
    "perf-issue": "xai/grok-4.7:xhigh",
    "hillclimb": "xai/grok-4.7:xhigh",
    "judgment and prose": "claude-subscription/claude-opus-5-5:xhigh",
    "hardest tasks": "claude-subscription/claude-opus-5-5:xhigh",
    "how explorer": "xai/grok-4.7:xhigh",
    "how explainer": "claude-subscription/claude-opus-5-5:xhigh",
    "why investigators": "xai/grok-4.7:xhigh",
    "why synthesizer": "claude-subscription/claude-opus-5-5:xhigh",
    "reflect tooling": "xai/grok-4.7:xhigh",
    "reflect judgment, divergent, synthesizer": "claude-subscription/claude-opus-5-5:xhigh",
    "arena runners": ["claude-subscription/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "arena cross-judge pool": ["claude-subscription/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "swarm workers": "xai/grok-4.7:xhigh",
    "architect runners": ["claude-subscription/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "interrogate reviewers": ["claude-subscription/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"]
  }
}
```

The provider names above are examples; write the ones step 1 detected. Delete a role to fall back to the skill default. `inherit-parent` or `auto` as a value runs the role on the parent chat's model. Alias entries in a panel list still count toward its fan-out.

### 6. Confirm

Tell the user the file was written and that skills read it on their next delegation. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /skill:create-verification-skill." On yes, invoke `/skill:create-verification-skill`. On no, move on without pushing.
