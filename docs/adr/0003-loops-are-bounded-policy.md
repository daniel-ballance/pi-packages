# Wake loops are bounded policy, not behaviour configuration

pistack's autonomous playbooks need a Parent that wakes itself until a predicate holds, which Pi has no built-in for (Cursor has `/loop`). We added `subagent_loop` to the `subagents` package and made it an **opt-in policy ceiling**: the optional `loops` field in `subagents.json` must enable loops and state every bound (minimum interval, maximum ticks, maximum duration), and omitting it disables them. A loop request can only stay within those bounds. This keeps the package's principle that a policy file is an allowlist and ceiling, and that no new autonomous behaviour broadens an existing configuration.

## Considered options

- **A behaviour setting** (for example a default interval in Pi settings, or loops always available): rejected, because every tick is a billable parent turn that nobody approved, and an existing policy would gain that silently.
- **A separate package**: rejected; ticks share the idle-only delivery rules of the subagents notification scheduler, and the policy file is already where a user caps what a Parent may start.
- **Child-driven loops only** (a watcher child, or a workflow `Loop`): kept as alternatives, documented, but they cannot wake an idle Parent on a timer.

## Consequences

Ticks reach only an idle Parent and never stack. A loop is session-scoped: a reload stops it rather than resuming unattended. Under T3 Code the package is inactive and T3's `schedule_task` and `watch_pull_request` are the equivalents.
