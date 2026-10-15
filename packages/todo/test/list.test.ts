import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, emptyList, formatList, formatWidget, parseOperation } from "../extensions/todo/src/list.js";

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

test("the widget shows one short line per item; notes stay in the tool result", () => {
  const long = "Reproduce it yourself on the matching surface via the control skill, even when a protocol says to ask the user to reproduce it.";
  const set = apply(emptyList, parseOperation({ op: "set", items: [long, "Plan the fix"] }) as never);
  assert.ok("list" in set);
  const updated = apply(set.list, parseOperation({ op: "update", id: 1, state: "done", note: "Reproduced via the CLI." }) as never);
  assert.ok("list" in updated);
  const lines = formatWidget(updated.list, 60);
  assert.equal(lines[0], "Todo: 1/2 resolved");
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => line.length <= 60), JSON.stringify(lines));
  assert.ok(lines[1]!.endsWith("…"));
  assert.equal(lines.join("\n").includes("Reproduced via"), false);
});
