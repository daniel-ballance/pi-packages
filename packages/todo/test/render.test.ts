import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Item, ItemState } from "../extensions/todo/src/list.js";
import { resultLines, widgetLines } from "../extensions/todo/src/render.js";

// Marks each style so a test can see it without ANSI codes.
const paint = { fg: (color: string, text: string) => color === "text" ? text : `<${color}>${text}</>`, bold: (text: string) => `*${text}*`, strikethrough: (text: string) => `~${text}~` };
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text };
const list = (states: ItemState[], text = (id: number) => `Step ${id}`): { items: Item[] } =>
  ({ items: states.map((state, index) => ({ id: index + 1, text: text(index + 1), state })) });

test("the widget is a progress header, then one styled line per item with the work in hand first", () => {
  const lines = widgetLines(list(["done", "skipped", "in_progress", "pending"]), 80, plain);
  assert.deepEqual(lines, [
    " Todo ━━━━━━────── 2/4 · 1 in progress",
    "  ◐ 3. Step 3",
    "  ○ 4. Step 4",
    "  ✓ 1. Step 1",
    "  ⊘ 2. Step 2",
  ]);
  const styled = widgetLines(list(["done", "skipped", "in_progress", "pending"]), 200, paint);
  assert.match(styled[1]!, /^  <accent>◐<\/> <accent>3\.<\/> \*Step 3\*/, "in progress stands out");
  assert.match(styled[3]!, /<success>✓<\/> <dim>1\. Step 1<\/>/, "done recedes");
  assert.match(styled[4]!, /<dim>~Step 2~<\/>/, "skipped is struck through");
});

test("the widget fits the terminal: long text is cut to the width, and a long list summarizes what it leaves out", () => {
  const long = list(["in_progress", "pending"], id => `Step ${id} `.repeat(30));
  assert.ok(widgetLines(long, 40, plain).every(line => visibleWidth(line) <= 40));
  assert.ok(widgetLines(long, 40, plain)[1]!.replace(/\x1b\[[0-9;]*m/g, "").endsWith("…"));
  const states: ItemState[] = [...Array(9).fill("done"), "in_progress", "pending", "pending"];
  const lines = widgetLines(list(states), 80, plain);
  assert.equal(lines.length, 11, "a header, nine items and the count");
  assert.deepEqual(lines.slice(1, 4), ["  ◐ 10. Step 10", "  ○ 11. Step 11", "  ○ 12. Step 12"], "numbers line up");
  assert.equal(lines.at(-1), "   … and 3 done");
});

test("an expanded call shows the whole list in number order, with notes", () => {
  const items = list(["done", "skipped", "in_progress"]).items;
  items[1] = { ...items[1]!, note: "single slice" };
  assert.deepEqual(resultLines({ items }, 80, plain), [
    "Todo ━━━━━━━━──── 2/3 · 1 in progress",
    " ✓ 1. Step 1",
    " ⊘ 2. Step 2 — skipped: single slice",
    " ◐ 3. Step 3",
  ]);
  const wrapped = resultLines(list(["pending"], () => "word ".repeat(12).trim()), 30, plain);
  assert.deepEqual(wrapped.slice(1), [" ○ 1. word word word", "      word word word word word", "      word word word word"], "wrapped text stays under the item");
});
