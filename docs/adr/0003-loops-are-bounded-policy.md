# Wake loops are bounded policy, not behaviour configuration

p3stack's autonomous playbooks need a Parent that can wake itself to check a condition. A loop needs an explicit request within policy limits: minimum interval, maximum ticks, and maximum duration. With no policy file, the built-in policy enables bounded loops. In a user policy, omitting `loops` disables them so existing configurations do not gain billable turns.

## Considered options

- **A behaviour setting** (for example a default interval in Pi settings, or loops always available): rejected, because every tick is a billable parent turn that nobody approved, and an existing policy would gain that silently.
- **A separate package**: rejected; ticks share the idle-only delivery rules of the subagents notification scheduler, and the policy file is already where a user caps what a Parent may start.
- **Child-driven loops only** (a watcher child, or a workflow `Loop`): kept as alternatives, documented, but they cannot wake an idle Parent on a timer.

## Consequences

Ticks reach only an idle Parent and never stack. A loop is session-scoped: a reload stops it rather than resuming unattended. Under T3 Code the package is inactive and T3's `schedule_task` and `watch_pull_request` are the equivalents.
