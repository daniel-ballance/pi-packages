---
name: principle-guard-the-context-window
description: "Apply when context is filling up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents; keep summaries in the main thread, not raw payloads."
disable-model-invocation: true
---

# Guard the Context Window

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.

**Where the procedure lives.** **Delegate** in the poteto-mode host capabilities (`../poteto-mode/references/host-capabilities.md`): send bulk reading to children, brief them with file pointers rather than pasted context, and keep their reports out of your context except for the summary. Save decisions and evidence paths in durable notes before you compact.
