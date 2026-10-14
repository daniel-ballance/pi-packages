# t3-subagents revamp

Date: **2026-10-14**. Status: **decided and implemented.**

## Decision

Inside T3 Code, Pi uses T3's subagent infrastructure directly. The
`t3-subagents` wrapper package is removed.

- T3's injected bridge registers `orchestrator_capabilities`, `delegate_task`,
  `task_status` and `task_cancel` as Pi tools, and T3's system prompt describes
  them. The model calls them as T3 instructs.
- T3's model configuration decides which providers and models children can use.
  There is no separate allowlist.
- T3's state is the record of delegated tasks. There is no local journal.
- The native [`subagents`](../packages/subagents/README.md) package is for Pi run
  directly. It stays inactive when T3 launches Pi with its MCP bridge
  (`T3_MCP_URL` set), with no launch flag needed. `--disable-native-subagents`
  still exists for other launches.

## Why the wrapper went

Compared against T3 Code upstream [`7ac952c`](https://github.com/pingdotgg/t3code/tree/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae),
679 commits after the revision the wrapper was built on:

- **Two tool surfaces for one job.** T3's system prompt names the raw tools; the
  wrapper's `t3_subagent_*` tools carried conflicting instructions.
- **Two approvals per delegation.** In supervised modes, T3's `tool_call` hook
  confirmed the wrapper call and again its nested `delegate_task` call. Read-only
  wrapper calls also prompted, while T3 lets its own read-only tools through
  (T3 `5f7294d45`).
- **Schema drift.** The wrapper rejected `isolation: "worktree"`, `role`,
  `runtimeMode`, `interactionMode`, `mode: "wait"` and `timeoutMs`.
- **Stale guidance.** Upstream follow-ups sent to a child's `childThreadId`
  create fresh tasks (T3 `c572cb71d`), and `task_cancel` documents its scope.
- **Workarounds no longer needed.** The bridge returns `structuredContent`
  (T3 `38c187bfb`). T3 also gives idle-time Pi extension work an owned
  continuation turn instead of stopping the session (T3 `f999eb2a8`).

## Known limits

- The native package still passes `T3_MCP_URL`/`T3_MCP_BEARER_TOKEN` to its
  children. That no longer matters inside T3, because the package is inactive
  there.
- T3's subagent UI shows native Pi subagents only for Pi's official example
  `subagent` tool shape. Showing this repository's native children would need a
  Pi-side lifecycle contract in T3 upstream.
- Requires a T3 build from 2026-10-13 or later for the behavior above. Older
  bridges still work with the raw tools but lack worktree isolation and
  structured results.
