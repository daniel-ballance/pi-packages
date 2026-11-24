### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer `ask_user` (**Ask the human**) over free text. Offer these four options with these exact labels, and name the current budget when the file records one. With no file, say that `large` matches the skill defaults.

- `unlimited, max thinking`
- `large, xhigh thinking`
- `medium, high thinking`
- `small, medium thinking`

**(b) Apply it.** Keep configured models, panel lists and parent aliases unless the user changes them. Resolve missing roles from the skill hints per **Models and role defaults**. Name any substitution. The file's `host` says where it was written. On that host, keep the exact pin or ask for another choice. On the other host, use the same family and thinking level and report the substitution. With no `host`, keep exact matches and treat the rest as other-host hints.

For code, offer each model's highest advertised thinking level at or below the budget. For judgment, use the same ceiling except that `small` allows `high`. Offer only judgment choices of `high` or above if any fit that ceiling. Otherwise say no offered model reaches the judgment floor within budget; let the user choose an advertised lower level or cancel. A model with no level within the ceiling is not a choice. In a standard panel, the judgment seat gets the judgment level and the code seat gets the code level. Parent aliases keep the parent's settings.

**(c) Show the roles and confirm.** Show every role with its model, marking any model not in the detected set as needing a choice. Also list each role step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat's model) as the options. Prefer `ask_user` over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena runs one judge. It tries only values from a family other than the parent's, in list order, so order it by preference. An `inherit-parent` or `auto` value never judges. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.
