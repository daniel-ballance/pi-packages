# Child delegation

Use a child for bounded, non-trivial work. First call `subagent_catalog` to see usable exact models, tools, and the live-child limit. Compose one focused child with `subagent_spawn`, selecting only the tools it needs and an explicit task and working directory. Parallelize only independent tasks and stay within the catalog limit. Call `subagent_wait` for the selected IDs, then `subagent_read` to inspect replies, errors, and requested artifacts. Verify the result; completion is not proof. Call `subagent_close` for every child after reading it, including failed work.

If catalog or spawn is unavailable, or the task has no retrieval tools available to the child, do the work directly or state the limitation. Do not assume a fallback model or child composition: unavailable catalog entries are not silently substituted.
