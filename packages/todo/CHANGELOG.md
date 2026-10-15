# Changelog

## Unreleased

- Add `add` (append items), `remove` (delete pending items added by mistake) and, on `update`, `text` (reword one item) and note-only changes. Numbers are never reused; snapshots record the next one.
- Label the hidden reminder and end-of-run check as the extension's, check at the end only when the run worked past its last `todo` call, and drop the end-of-run warning.
- Order the widget by focus (in progress, pending, resolved), summarize what doesn't fit instead of letting Pi truncate it, and style it and expanded calls with the theme.
- Keep the list current: after four turns without a `todo` call while items are open, add one hidden reminder; when a request that used the list ends with items open, add one hidden nudge and one more turn to mark them. `update` takes `ids` for several items at once, and `set`'s result says to update as items finish.
- Show each change once in the TUI transcript, as a one-line tool call that expands to the list; stored snapshots no longer render a second copy.
- Add the `todo` tool: `set`, `update` and `get`; items are never deleted and a skip needs a reason; per-branch persistence through session entries; a TUI widget, transcript entries and a warning when a run ends with work in progress; complete plain-text and structured results; deferred exposure under T3 only when T3 offers its own todo tool.
