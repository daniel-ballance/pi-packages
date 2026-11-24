### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer `ask_user` (**Ask the human**) over free text. Offer the options below with their exact labels, and name the current budget when the file records one. With no file, say that `large` matches the skill defaults.

{{budget-options}}

**(b) Apply it.** Keep configured models, panel lists and parent aliases unless the user changes them. Resolve missing roles from the skill hints per **Models and role defaults**. Name any substitution. The file's `host` says where it was written. On that host, keep the exact pin or ask for another choice. On the other host, use the same family and thinking level and report the substitution. With no `host`, keep exact matches and treat the rest as other-host hints.

For code, offer each model's highest advertised thinking level at or below the budget. For judgment, use the same ceiling except that `small` allows `high`. Offer only judgment choices of `high` or above if any fit that ceiling. Otherwise say no offered model reaches the judgment floor within budget; let the user choose an advertised lower level or cancel. A model with no level within the ceiling is not a choice. In a standard panel, the judgment seat gets the judgment level and the code seat gets the code level. Parent aliases keep the parent's settings.

**(c) Show the roles and confirm.** Group unchanged roles by selection. Show overrides, unavailable choices and any retired roles (absent from step 5) to drop. Confirm changes with the user. Offer detected models or a parent alias (`inherit-parent` or `auto`). For a panel, each list entry runs one child, alias entries included. `arena cross-judge pool` is also a list, but Arena runs one judge. It tries only values from a family other than the parent's, in list order, so order it by preference. An `inherit-parent` or `auto` value never judges. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.
