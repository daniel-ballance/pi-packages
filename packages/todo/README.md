# todo

A `todo` tool for Pi. The model keeps the current task's steps in a list where a
step it started or decided against is never deleted: each one ends `done` or
`skipped` with a reason. Only a pending item added by mistake can be removed. It
is the todo list pistack's playbooks copy their steps into, and it works on its
own.

## Tool

One tool, `todo`, with five operations:

| Operation | Parameters | Effect |
|---|---|---|
| `set` | `items`: the steps, in order | Replaces the list; items are numbered from 1 and start `pending`. |
| `add` | `items` | Appends `pending` items, numbered after the highest number the list has used. The rest of the list is unchanged. |
| `update` | `id` or `ids`; `state?`, `text?`, `note?` | Changes one item (`id`) or several (`ids`, all or none). `state` moves them to `pending`, `in_progress`, `done` or `skipped`, and `skipped` requires a reason in `note`. A new state drops the old note unless `note` gives one. `text` rewords a single item. `note` alone replaces the note and keeps the state. At least one of the three is needed. |
| `remove` | `id` or `ids` | Deletes `pending` items, all or none, such as a duplicate or a mistaken step. An item in progress, done or skipped can't be removed; a step the model decides not to do is `skipped` with a reason instead. Numbers are not reused. |
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

## Keeping the list current

Models tend to set the list and then forget it while they work, because nothing in
their context mentions it again. The extension does, with hidden messages the user
does not see. Pi gives a hidden message to the model as a user message, so each is
labelled as the extension's, says the user does not see it, and asks for no reply.

- **During a run:** after four turns with tool calls but no `todo` call while
  items are open, one short reminder of the count and the next open item. It
  repeats only after the next `todo` call.
- **At the end of a request:** if the request used the list, then used other
  tools after its last `todo` call, and items are still open, one more turn to
  mark them done or skipped. Items left open on purpose, for example waiting on
  delegated work, stay as they are, and the model is asked to end without
  writing anything, so the user's last answer stands. This happens once per
  request, never for the continuation it starts. A run whose last tool call was
  `todo` is not checked: the list is as the model left it.

`set`'s result also says to update items as they finish, and that codemode
scripts can call `tools.todo`.

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
  open: a progress bar, then one line per item cut to the terminal's width, with
  the work in hand first. Items in progress (◐) come first, then pending (○),
  then done (✓) and skipped (⊘), by number within each group. It shows ten
  items at most: past that, resolved items give way first and a last line
  counts what is left out. Notes stay in the tool result. In the transcript
  each change is one tool-call line, such as `Item 3 is done. · 3/7 resolved`;
  expand it to see the whole list in number order, with notes. Items still in
  progress when a run ends stay in the widget; there is no separate warning.
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
