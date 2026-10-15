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

test("items are never deleted, and unknown ids and malformed operations are errors", () => {
  const { list } = ok(apply(emptyList, { op: "set", items: ["Frame"] }));
  assert.match((apply(list, { op: "update", ids: [7], state: "done" }) as { error: string }).error, /no item 7/);
  for (const params of [{ op: "delete", id: 1 }, { op: "set", items: [] }, { op: "set", items: ["", "x"] }, { op: "update", id: 1, state: "finished" }, { op: "update", state: "done" }, {}]) {
    assert.ok("error" in parseOperation(params), JSON.stringify(params));
  }
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
