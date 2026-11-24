# todo

A `todo` tool for Pi. Mark finished steps `done` and intentionally omitted
steps `skipped` with a reason. Use `remove` for mistakes: it checks that the
item is currently pending, not whether it was ever started. `set` replaces the
whole list. The tool works on its own or with p3stack's playbooks.

## Tool

One tool, `todo`, with five operations:

| Operation | Parameters | Effect |
|---|---|---|
| `set` | `items`: the steps, in order | Replaces the list; items are numbered from 1 and start `pending`. |
| `add` | `items` | Appends `pending` items, numbered after the highest number the list has used. The rest of the list is unchanged. |
| `update` | `id` or `ids`; `state?`, `text?`, `note?` | Changes one item (`id`) or several (`ids`, all or none). `state` moves them to `pending`, `in_progress`, `done` or `skipped`, and `skipped` requires a reason in `note`. A new state drops the old note unless `note` gives one. `text` rewords a single item. `note` alone replaces the note and keeps the state. At least one of the three is needed. |
| `remove` | `id` or `ids` | Deletes `pending` items, all or none, such as a duplicate or a mistaken step. An item in progress, done or skipped can't be removed; a step the model decides not to do is `skipped` with a reason instead. Numbers are not reused. |
| `get` | | Returns the list. |

`set`, `get` and errors return the complete list as plain text. Successful
`add`, `update` and `remove` return the change, counts for the entire list and
only the items still open, for example:

```text
Item 2 is skipped.
Todo: 1 done, 1 skipped, 1 in progress, 0 pending
[>] 3. Report
```

`structuredContent` (`items`, `counts`) and renderer `details` always carry the full list.
An invalid operation, such as a skip without a reason or an unknown id, returns
an error result with the unchanged list and changes nothing.

## Keeping the list current

Models tend to set the list and then forget it while they work, because nothing in
their context mentions it again. The extension does, with hidden messages the user
does not see. Pi gives a hidden message to the model as a user message, so each is
labelled as the extension's, says the user does not see it, and asks for no reply.

- **During a run:** after four turns with tool calls but no `todo` call while
  items are open, one short reminder of the count and the next open item. It
  repeats only after the next `todo` call or in a new request. Calls to
  `tools.todo` inside codemode scripts count as todo calls.
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
valid todo entry on the active branch, so `/fork`, `/tree` and resumed sessions show the
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
- **T3 Code and other RPC clients:** while items are open, a `todo` status
  shows the resolved/total count and the first open step in list order (up to
  60 characters). It clears when no items remain open.
- **Without UI** (print mode), nothing touches the UI; results are unchanged.

Under T3 Code the tool stays active, because T3 gives Pi no todo tool of its
own.

## Install

The root package installs it through p3stack. To install p3stack without the other root packages:

```sh
pi install /path/to/pi-packages/packages/p3stack
```

For a local checkout, run `npm ci --ignore-scripts` at the repository root
first (see the root README).

## Development

`npm run check` type-checks against the latest Pi development copy.
`npm test` runs the suite twice: as a terminal launch and with a fake
`T3_MCP_URL`, so host-specific behaviour is covered on both hosts.
