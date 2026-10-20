### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer `ask_user` (**Ask the human**) over free text. Offer these four options with these exact labels, and name the current budget when the file records one. With no file, say that `large` matches the skill defaults.

- `unlimited — max thinking`
- `large — xhigh thinking`
- `medium — high thinking`
- `small — medium thinking`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`, `auto`). Resolve every default hint to a detected model per **Models and role defaults**. `unlimited`, `large`, `medium`, and `small` set the thinking level of every real model, panel entries included, to `max`, `xhigh`, `high`, or `medium`. If a model does not offer that level, use its highest offered level at or below the target, else mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `unlimited` puts Claude Opus 5.5 at `max`, while Grok 4.7, which tops out at `xhigh`, stays at `xhigh`. `small` puts both at `medium`.

**(c) Show the roles and confirm.** Show every role with its model, marking any model not in the detected set as needing a choice. Also list each role step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat's model) as the options. Prefer `ask_user` over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.
