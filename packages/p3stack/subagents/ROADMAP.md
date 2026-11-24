# Subagents: deferred decisions

One root manager owns the child tree. Policy may grant a child bounded management proxies for its subtree; messaging alone grants none. There is no child management API for editing policy, linking peers, releasing holds or deciding human checks. This is a Pi tool boundary, not a filesystem or provider-call firewall. See the [current contract](README.md).

- **Communication:** Keep [point-to-point links](PEER-MESSAGING.md). Channels, boards, cross-parent messages and automatic replay need explicit identity, visibility, delivery and billing semantics. A receipt does not mean the recipient read or answered.
- **Workflows:** Keep the [static DAG and bounded worker/check loops](skills/workflows/reference/contract.md). Defer dynamic graphs, quorum joins, arbitrary loop bodies, evaluator plugins and concurrent runs until a concrete workload needs them. Merging or deploying an artifact requires separate authorization.
- **Managed built-ins:** Pi owns the MCP client. Credential isolation, additional MCP resources, classifier grants and virtual routing require verifiable interception APIs; see the [built-in contract](skills/subagents/reference/builtins.md).
- **Isolation:** Tool selection and a starting cwd do not contain a host-user process. An isolation backend needs a threat model, explicit filesystem/network/credential boundaries, supervised cleanup, and a failure mode that cannot silently downgrade a sandboxed task.
- **Lifecycle:** Orderly parent shutdown stops attached children; a crash can orphan processes. Saved conversations resume only on request. A detached supervisor needs a demonstrated need for work to survive parent exit and a design for authentication, ownership and recovery.

These are not new policy fields or a release schedule.
