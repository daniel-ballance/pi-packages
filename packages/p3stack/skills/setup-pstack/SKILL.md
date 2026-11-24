---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes the role defaults file that overrides the skill defaults. Use for /skill:setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write `~/.pi/agent/p3stack.json`, the role defaults file that sets p3stack's model per role.

## Steps

In a terminal with p3stack's extension loaded, `/p3stack-setup` does steps 1 to 5 for the common case: one code model, one judgment model, panels of both. Offer it when the user wants nothing finer; follow the steps below otherwise, and always under T3.

### 1. Detect available models

List the models you can delegate to from the model catalog (**Delegate** in the [host capabilities](../poteto-mode/references/host-capabilities.md)). That list is the dependable source. Record each model's exact identity and the thinking levels it offers. Use only this host's catalog. If the short list omits a requested model, look it up there by its full id. If the catalog cannot confirm a usable selection, stop without writing. Under T3 a successful unfiltered lookup also supplies `/p3stack-setup` in this session for the two-model wizard. The aliases `inherit-parent` and `auto` mean the parent chat's model; they are valid when that model is in the detected set (a terminal allowlist may exclude it).

### 2. Load current state

The default role-to-model mapping is the file shape shown in step 5 below. Use the first valid role file: `.pi/p3stack.json` in a trusted project, then `p3stack.json` in Pi's agent directory (`PI_CODING_AGENT_DIR` when nonempty, otherwise `~/.pi/agent`; expand a leading `~`). Report any malformed file you skip. Use that file's budget and roles, with skill defaults for missing roles. With no valid file, use the defaults. A role not in step 5, such as `how critics`, is retired. Drop it.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer `ask_user` (**Ask the human**) over free text. Offer these four options with these exact labels, and name the current budget when the file records one. With no file, say that `large` matches the skill defaults.

- `unlimited, max thinking`
- `large, xhigh thinking`
- `medium, high thinking`
- `small, medium thinking`

**(b) Apply it.** Keep configured models, panel lists and parent aliases unless the user changes them. Resolve missing roles from the skill hints per **Models and role defaults**. Name any substitution. If a pin cannot run within its family (and its named instance under T3), ask for another choice.

For code, offer each model's highest advertised thinking level at or below the budget. For judgment, use the same ceiling except that `small` allows `high`. Offer only judgment choices of `high` or above if any fit that ceiling. Otherwise say no offered model reaches the judgment floor within budget; let the user choose an advertised lower level or cancel. A model with no level within the ceiling is not a choice. In a standard panel, the judgment seat gets the judgment level and the code seat gets the code level. Parent aliases keep the parent's settings.

**(c) Show the roles and confirm.** Show every role with its model, marking any model not in the detected set as needing a choice. Also list each role step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat's model) as the options. Prefer `ask_user` over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena runs one judge. It tries only values from a family other than the parent's, in list order, so order it by preference. An `inherit-parent` or `auto` value never judges. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real model written must be in the detected set, with a thinking level it offers. `inherit-parent` and `auto` pass when the parent chat's model is in the detected set; otherwise mark the role as needing a choice. If a chosen model is not available, stop and ask again.

### 5. Write the file

Write `p3stack.json` in Pi's agent directory (step 2), or `.pi/p3stack.json` for a trusted project-only choice. Ask before replacing an existing file. Without confirmation, leave it unchanged. Record the budget and exact selections:

- Terminal: `<provider>/<model id>:<thinking>`.
- T3: `<provider instance>/<model id>:<thinking>`. Keep the whole model id, including any slashes. For instance `pi` offering model `xai/grok-4.7` at `xhigh`, write `pi/xai/grok-4.7:xhigh`.

Example terminal file:

```json
{
  "budget": "large (xhigh)",
  "roles": {
    "feature, refactoring": "xai/grok-4.7:xhigh",
    "bug-fix": "xai/grok-4.7:xhigh",
    "perf-issue": "xai/grok-4.7:xhigh",
    "hillclimb": "xai/grok-4.7:xhigh",
    "judgment and prose": "claude/claude-opus-5-5:xhigh",
    "hardest tasks": "claude/claude-opus-5-5:xhigh",
    "how explorer": "xai/grok-4.7:xhigh",
    "how explainer": "claude/claude-opus-5-5:xhigh",
    "why investigators": "xai/grok-4.7:xhigh",
    "why synthesizer": "claude/claude-opus-5-5:xhigh",
    "reflect tooling": "xai/grok-4.7:xhigh",
    "reflect judgment, divergent, synthesizer": "claude/claude-opus-5-5:xhigh",
    "arena runners": ["claude/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "arena cross-judge pool": ["claude/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "swarm workers": "xai/grok-4.7:xhigh",
    "architect runners": ["claude/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "interrogate reviewers": ["claude/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"]
  }
}
```

Report the destination, budget and role selections actually written, including any lower judgment level. Use the providers step 1 detected. Delete a role to fall back to the skill default. `inherit-parent` or `auto` as a value runs the role on the parent chat's model. Alias entries in a panel list still count toward its fan-out.

### 6. Confirm

Tell the user the file was written and that skills read it on their next delegation. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /skill:create-verification-skill." On yes, invoke `/skill:create-verification-skill`. On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /skill:create-formal-verification-skill." On yes, invoke `/skill:create-formal-verification-skill`. On no, move on without pushing.
