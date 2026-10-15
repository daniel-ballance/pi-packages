# todo

A `todo` tool for Pi. The model keeps the current task's steps in a list where
no step is ever deleted: each one ends `done` or `skipped` with a reason. It is
the todo list pistack's playbooks copy their steps into, and it works on its own.

## Tool

One tool, `todo`, with three operations:

| Operation | Parameters | Effect |
|---|---|---|
| `set` | `items`: the steps, in order | Replaces the list; items are numbered from 1 and start `pending`. |
| `update` | `id`, `state`, `note?` | Moves one item to `pending`, `in_progress`, `done` or `skipped`. `skipped` requires a reason in `note`. |
| `get` | | Returns the list. |

Every result is the complete list as plain text, for example:

```text
Item 2 is skipped.
Todo: 1 done, 1 skipped, 1 in progress, 0 pending
[x] 1. Frame
[-] 2. Fan out (skip: single slice)
[>] 3. Report
```

Results also carry `structuredContent` (`items`, `counts`) for codemode scripts.
An invalid operation, such as a skip without a reason or an unknown id, returns
an error result with the unchanged list and changes nothing.

Provider tool schemas must be a single flat object, so the rule that a skip
needs a reason cannot be expressed in the schema itself; the tool enforces it
when the call arrives.

## Sessions and branches

Each change is stored as a session entry (`appendEntry`, type `todo`). On
session start and after `/tree` navigation the list is rebuilt from the last
entry on the active branch, so `/fork`, `/tree` and resumed sessions show the
list as it was at that point. Changes made from codemode scripts are stored the
same way.

## Interfaces

- **Terminal (TUI):** a widget above the editor shows the list while any item is
  open, one short line per item (notes stay in the tool result). In the
  transcript each change is one tool-call line, such as
  `Item 3 is done. · 3/7 resolved`; expand it to see the whole list. When a run
  ends with an item still `in_progress`, a warning names it.
- **T3 Code and other RPC clients:** the tool result text is complete on its
  own; the widget and the compact rendering are additions a client may ignore.
- **Without UI** (print mode), nothing touches the UI; results are unchanged.

Under T3 Code the tool stays active, because T3 gives Pi no todo tool of its
own. If a T3 release adds one (`mcp__t3-code__*todo*`), this tool steps aside to
`exposure: "deferred"`: still reachable through `tool_search` and codemode, but
no longer declared next to T3's.

## Install

The collection installs it. To install it without the rest of the collection:

```sh
pi install /path/to/pi-packages/packages/todo
```

For a local checkout, run `npm ci --ignore-scripts` at the repository root
first (see the root README).

## Development

`npm run check` type-checks against the pinned Pi 1.3.0 development copy.
`npm test` runs the suite twice: as a terminal launch and with a fake
`T3_MCP_URL`, so host-specific behaviour is covered on both hosts.
