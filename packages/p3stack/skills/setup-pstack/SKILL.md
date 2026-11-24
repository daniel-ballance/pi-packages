---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes the role defaults file that overrides the skill defaults. Use for /skill:setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write personal role defaults to `<agent-dir>/p3stack.json`, where `<agent-dir>` is Pi's agent directory (`PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`).

## Steps

For personal defaults in interactive Pi, offer `/p3stack-setup`: one code model, one judgment model, panels of both. Under T3, if setup requests a catalog, call `p3stack_roles` once and rerun setup. After a successful write, continue at step 6. For per-role choices or a trusted project file, use steps 1 to 5.

### 1. Detect available models

List the models you can delegate to from the model catalog (**Delegate** in the [host capabilities](../poteto-mode/references/host-capabilities.md)). That list is the dependable source. Record each model's exact identity and the thinking levels it offers. Use only this host's catalog. If the short list omits a requested model, look it up there by its full id. If the catalog cannot confirm a usable selection, stop without writing. The aliases `inherit-parent` and `auto` mean the parent chat's model; they are valid when that model is in the detected set (a terminal allowlist may exclude it).

### 2. Load current state

Call `p3stack_roles` for the active file, budget, resolved choices and problems. It uses the first valid file: `.pi/p3stack.json` in a trusted project, then `p3stack.json` in Pi's agent directory. Read that file for the user's original pins, lists and aliases. Report skipped files. With no valid file, start from the resolved skill hints.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer `ask_user` (**Ask the human**) over free text. Offer the options below with their exact labels, and name the current budget when the file records one. With no file, say that `large` matches the skill defaults.

- `unlimited, max thinking`
- `large, xhigh thinking`
- `medium, high thinking`
- `small, medium thinking`

**(b) Apply it.** Keep configured models, panel lists and parent aliases unless the user changes them. Resolve missing roles from the skill hints per **Models and role defaults**. Name any substitution. The file's `host` says where it was written. On that host, keep the exact pin or ask for another choice. On the other host, use the same family and thinking level and report the substitution. With no `host`, keep exact matches and treat the rest as other-host hints.

For code, offer each model's highest advertised thinking level at or below the budget. For judgment, use the same ceiling except that `small` allows `high`. Offer only judgment choices of `high` or above if any fit that ceiling. Otherwise say no offered model reaches the judgment floor within budget; let the user choose an advertised lower level or cancel. A model with no level within the ceiling is not a choice. In a standard panel, the judgment seat gets the judgment level and the code seat gets the code level. Parent aliases keep the parent's settings.

**(c) Show the roles and confirm.** Group unchanged roles by selection. Show overrides, unavailable choices and any retired roles (absent from step 5) to drop. Confirm changes with the user. Offer detected models or a parent alias (`inherit-parent` or `auto`). For a panel, each list entry runs one child, alias entries included. `arena cross-judge pool` is also a list, but Arena runs one judge. It tries only values from a family other than the parent's, in list order, so order it by preference. An `inherit-parent` or `auto` value never judges. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real model written must be in the detected set, with a thinking level it offers. `inherit-parent` and `auto` pass when the parent chat's model is in the detected set; otherwise mark the role as needing a choice. If a chosen model is not available, stop and ask again.

### 5. Write the file

Write `p3stack.json` in Pi's agent directory (step 2), or `.pi/p3stack.json` for a trusted project-only choice. Ask before replacing an existing file. Without confirmation, leave it unchanged. Set `host` to `terminal` or `t3` for the host writing the file. Use the confirmed catalog identities, including the thinking level:

- Terminal: `<provider>/<model id>:<thinking>`.
- T3: `<provider instance>/<model id>:<thinking>`. Keep the whole model id, including any slashes.

Example shape for two terminal selections (not model defaults):

```json
{
  "host": "terminal",
  "budget": "large (xhigh)",
  "roles": {
    "feature, refactoring": "example/code:xhigh",
    "bug-fix": "example/code:xhigh",
    "perf-issue": "example/code:xhigh",
    "hillclimb": "example/code:xhigh",
    "how explorer": "example/code:xhigh",
    "why investigators": "example/code:xhigh",
    "reflect tooling": "example/code:xhigh",
    "swarm workers": "example/code:xhigh",
    "judgment and prose": "example/judge:xhigh",
    "hardest tasks": "example/judge:xhigh",
    "how explainer": "example/judge:xhigh",
    "why synthesizer": "example/judge:xhigh",
    "reflect judgment, divergent, synthesizer": "example/judge:xhigh",
    "arena runners": [
      "example/judge:xhigh",
      "example/code:xhigh"
    ],
    "arena cross-judge pool": [
      "example/judge:xhigh",
      "example/code:xhigh"
    ],
    "architect runners": [
      "example/judge:xhigh",
      "example/code:xhigh"
    ],
    "interrogate reviewers": [
      "example/judge:xhigh",
      "example/code:xhigh"
    ]
  }
}
```

Omit a role to use its skill default.

### 6. Confirm

Tell the user the file was written and that skills read it on their next delegation. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /skill:create-verification-skill." On yes, invoke `/skill:create-verification-skill`. On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /skill:create-formal-verification-skill." On yes, invoke `/skill:create-formal-verification-skill`. On no, move on without pushing.
