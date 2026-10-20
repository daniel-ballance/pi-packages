import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, emptyList, focusOrder, formatList, parseOperation, widgetRows, type Item, type ItemState } from "../extensions/todo/src/list.js";

function ok<T>(value: T): Exclude<T, { readonly error: string }> {
  if (typeof value === "object" && value !== null && "error" in value) assert.fail(String(value.error));
  return value as Exclude<T, { readonly error: string }>;
}

test("set copies steps verbatim as pending items numbered from 1", () => {
  const { list } = ok(apply(emptyList, ok(parseOperation({ op: "set", items: ["Frame", "Fan out"] }))));
  assert.deepEqual(list.items, [
    { id: 1, text: "Frame", state: "pending" },
    { id: 2, text: "Fan out", state: "pending" },
  ]);
});

test("update moves an item through its states and keeps a note", () => {
  let { list } = ok(apply(emptyList, { op: "set", items: ["Frame", "Fan out"] }));
  ({ list } = ok(apply(list, ok(parseOperation({ op: "update", id: 1, state: "in_progress" })))));
  ({ list } = ok(apply(list, ok(parseOperation({ op: "update", id: 1, state: "done", note: "predicate written" })))));
  assert.deepEqual(list.items[0], { id: 1, text: "Frame", state: "done", note: "predicate written" });
});

test("skipping requires a non-empty reason", () => {
  for (const note of [undefined, "", "   "]) {
    const parsed = parseOperation({ op: "update", id: 1, state: "skipped", note });
    assert.ok("error" in parsed);
    assert.match(parsed.error, /skipped.*reason/);
  }
  const { list } = ok(apply(ok(apply(emptyList, { op: "set", items: ["Frame"] })).list, ok(parseOperation({ op: "update", id: 1, state: "skipped", note: "no fan-out needed" }))));
  assert.deepEqual(list.items[0], { id: 1, text: "Frame", state: "skipped", note: "no fan-out needed" });
});

test("unknown ids and malformed operations are errors", () => {
  const { list } = ok(apply(emptyList, { op: "set", items: ["Frame"] }));
  assert.match((apply(list, { op: "update", ids: [7], state: "done" }) as { error: string }).error, /no item 7/);
  for (const params of [
    { op: "delete", id: 1 }, { op: "set", items: [] }, { op: "set", items: ["", "x"] }, { op: "update", id: 1, state: "finished" }, { op: "update", state: "done" }, {},
    { op: "add", items: [] }, { op: "add" }, { op: "remove" }, { op: "remove", ids: [] },
    { op: "update", id: 1 }, { op: "update", id: 1, text: "  " }, { op: "update", ids: [1, 2], text: "Same words twice" },
  ]) {
    assert.ok("error" in parseOperation(params), JSON.stringify(params));
  }
});

test("add appends pending items with new numbers, after any that were removed", () => {
  let { list } = ok(apply(emptyList, { op: "set", items: ["Frame", "Fan out"] }));
  ({ list } = ok(apply(list, { op: "update", ids: [1], state: "done" })));
  const added = ok(apply(list, ok(parseOperation({ op: "add", items: ["Report", "Ship"] }))));
  assert.equal(added.change, "Added items 3, 4.");
  assert.deepEqual(added.list.items.map(item => [item.id, item.text, item.state]), [[1, "Frame", "done"], [2, "Fan out", "pending"], [3, "Report", "pending"], [4, "Ship", "pending"]]);
  const removed = ok(apply(added.list, { op: "remove", ids: [4] })).list;
  const again = ok(apply(removed, { op: "add", items: ["Announce"] }));
  assert.equal(again.change, "Added item 5.", "a removed item's number is not reused");
  assert.equal(ok(apply(emptyList, { op: "add", items: ["First"] })).list.items[0]!.id, 1);
});

test("update rewords one item, or sets a note, without changing its state", () => {
  let { list } = ok(apply(emptyList, { op: "set", items: ["Frame", "Fan out"] }));
  const reworded = ok(apply(list, ok(parseOperation({ op: "update", id: 2, text: "Fan out to three Children" }))));
  assert.equal(reworded.change, "Item 2 now reads: Fan out to three Children.");
  assert.deepEqual(reworded.list.items[1], { id: 2, text: "Fan out to three Children", state: "pending" });
  ({ list } = ok(apply(reworded.list, ok(parseOperation({ op: "update", id: 2, text: "Fan out to two", state: "in_progress" })))));
  assert.deepEqual(list.items[1], { id: 2, text: "Fan out to two", state: "in_progress" });
  const noted = ok(apply(list, ok(parseOperation({ op: "update", id: 2, note: "waiting on one Child" }))));
  assert.equal(noted.change, "Item 2 has a new note.");
  assert.deepEqual(noted.list.items[1], { id: 2, text: "Fan out to two", state: "in_progress", note: "waiting on one Child" });
});

test("remove deletes only items never started; a step not done is skipped instead", () => {
  let { list } = ok(apply(emptyList, { op: "set", items: ["Frame", "Fan out", "Fan out", "Report"] }));
  ({ list } = ok(apply(list, { op: "update", ids: [1], state: "done" })));
  ({ list } = ok(apply(list, { op: "update", ids: [2], state: "in_progress" })));
  const removed = ok(apply(list, ok(parseOperation({ op: "remove", id: 3 }))));
  assert.equal(removed.change, "Removed item 3.");
  assert.deepEqual(removed.list.items.map(item => item.id), [1, 2, 4]);
  for (const id of [1, 2]) {
    const refused = apply(list, { op: "remove", ids: [id, 3] }) as { error: string };
    assert.match(refused.error, new RegExp(`item ${id} is (done|in progress); only pending items can be removed.*skipped.*reason`), "all or nothing");
  }
  assert.match((apply(list, { op: "remove", ids: [9] }) as { error: string }).error, /no item 9/);
});

test("update takes several ids at once, all or nothing", () => {
  const { list } = ok(apply(emptyList, { op: "set", items: ["Frame", "Fan out", "Report"] }));
  const both = ok(apply(list, ok(parseOperation({ op: "update", ids: [1, 2], state: "done" }))));
  assert.equal(both.change, "Items 1, 2 are done.");
  assert.deepEqual(both.list.items.map(item => item.state), ["done", "done", "pending"]);
  assert.match((apply(list, ok(parseOperation({ op: "update", ids: [2, 9], state: "done" }))) as { error: string }).error, /no item 9/);
  for (const params of [{ op: "update", id: 1, ids: [2], state: "done" }, { op: "update", ids: [], state: "done" }, { op: "update", ids: [0], state: "done" }]) {
    assert.ok("error" in parseOperation(params), JSON.stringify(params));
  }
});

test("the plain-text list carries every item, its state and its note", () => {
  let { list } = ok(apply(emptyList, { op: "set", items: ["Frame", "Fan out", "Report"] }));
  ({ list } = ok(apply(list, { op: "update", ids: [1], state: "done" })));
  ({ list } = ok(apply(list, { op: "update", ids: [2], state: "skipped", note: "single slice" })));
  ({ list } = ok(apply(list, { op: "update", ids: [3], state: "in_progress" })));
  assert.equal(formatList(list), [
    "Todo: 1 done, 1 skipped, 1 in progress, 0 pending",
    "[x] 1. Frame",
    "[-] 2. Fan out (skip: single slice)",
    "[>] 3. Report",
  ].join("\n"));
  assert.equal(formatList(emptyList), "Todo: no items");
});

const items = (states: ItemState[]): Item[] => states.map((state, index) => ({ id: index + 1, text: `Step ${index + 1}`, state }));

test("the widget order puts the work in hand first: in progress, pending, then resolved, by number within each", () => {
  const list = items(["done", "pending", "in_progress", "skipped", "pending", "in_progress", "done"]);
  assert.deepEqual(focusOrder(list).map(item => item.id), [3, 6, 2, 5, 1, 4, 7]);
});

test("a long list leaves out resolved items before open ones, and counts what it leaves out", () => {
  const list = { items: items(["done", "done", "done", "done", "done", "done", "done", "done", "in_progress", "pending", "pending", "pending"]) };
  const { shown, hidden } = widgetRows(list, 10);
  assert.equal(shown.length, 9, "one row is kept for the count");
  assert.deepEqual(shown.slice(0, 4).map(item => item.id), [9, 10, 11, 12], "every open item shows");
  assert.deepEqual(hidden, { pending: 0, in_progress: 0, done: 3, skipped: 0 });
  const short = widgetRows({ items: items(["done", "pending"]) }, 10);
  assert.deepEqual([short.shown.map(item => item.id), short.hidden.done + short.hidden.pending], [[2, 1], 0]);
});
