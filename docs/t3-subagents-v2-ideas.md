# t3-subagents V2 ideas

Status: **proposal, not an agreed implementation specification**. Recorded 2026-10-07.

## Starting point

The current [package](../packages/t3-subagents/README.md) is a bounded T3-owned
asynchronous task wrapper. It tracks delegation/cancellation intents and saved
identities, offers explicit reads, and leaves execution, permissions, workspace,
completion delivery and parent wake-ups to T3. It does not consume `subagents.json`
or provide native persistent-Child parity.

## Proposed priorities

1. **Policy convention support.** Use familiar `subagents.json` discovery and
   whole-file precedence, with explicit T3 provider-instance/model/option
   allowlisting and advisory model-selection guidance. Decide the schema and
   coexistence with native policies before implementation; do not imply an
   unchanged native file is automatically compatible. T3 capability discovery
   remains distinct from package authorization.
2. **Strict compatibility validation.** Apply only constraints the selected T3
   contract can enforce. Reject unsupported native tool/resource/context/cwd,
   peer or lifecycle requirements before admission, rather than silently dropping
   them or treating prompt instructions as enforcement. Describe the scope of
   policy enforcement accurately, including direct access to raw T3 tools.
3. **Optional bounded workflow integration.** Explore the existing `WorkflowHost`
   seam for task DAGs and checks. Advance work only in T3-owned parent turns;
   retain T3's execution, permission, cancellation and notification ownership.
   Define persisted attempts, request keys, result acknowledgement and recovery
   before introducing scheduling. No competing timer-driven parent wake-ups.

Native persistent collaborators, peer messaging and exact tool/resource/cwd
composition are not promised V2 features. Their semantics need additional T3
contracts, not a renamed API or a prompt-only approximation.

## Additional validation before integration

- Genuine supervised-mode approval and rejection, including nested bridge calls;
  human-required prompts must remain human decisions.
- Delayed completion after the parent turn ends: one T3-owned continuation and
  no unsolicited Pi turn or native report.
- Injected lost/malformed responses and timeouts: persisted uncertain intents,
  unchanged-key recovery and no untracked duplicate admission. Cache expiry and
  lost history cannot provide a global exactly-once guarantee.
- Deployed cancellation behavior for expendable tasks with descendants and
  later backing-thread work. Distinguish requested cancellation from terminal
  confirmation; do not generalize one deployed version to all T3 releases.

Use isolated test sessions and test-only fault injection. Avoid disrupting the
running T3 server or changing personal settings. Record verified results and any
remaining limits in the [live smoke report](t3-code-subagents-smoke-test.md).
