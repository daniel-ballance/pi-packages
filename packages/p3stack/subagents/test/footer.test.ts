import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { decorateFooter, formatSubagentSummary, installFooterDecoration } from "../extensions/subagents/src/footer.js";
const dim = (text: string) => `\x1b[38;5;242m${text}\x1b[39m`;
const label = "subagents: 0/4 of 3 • $1.234";

test("summary counts active/all children and sums cumulative costs including closed sessions", () => {
  assert.equal(formatSubagentSummary([
    { status: "working", usage: { cost: 0.1234 } },
    { status: "idle", usage: { cost: 0.2 } },
    { status: "stopped", usage: { cost: 0.9106 } },
  ], 8), "subagents: 1/8 of 3 • $1.234");
  const resumed = [{ status: "working", usage: { cost: 1 } }];
  assert.equal(formatSubagentSummary(resumed, 8), "subagents: 1/8 of 1 • $1.000");
  resumed[0].usage = { cost: 1.25 };
  resumed[0].status = "stopped";
  assert.equal(formatSubagentSummary(resumed, 8), "subagents: 0/8 of 1 • $1.250");
});

test("summary handles no agents, missing/invalid costs and all active lifecycle states", () => {
  assert.equal(formatSubagentSummary([], 4), "");
  assert.equal(formatSubagentSummary([
    { status: "starting" }, { status: "waiting_input", usage: { cost: NaN } },
    { status: "failed", usage: { cost: -1 } }, { status: "stopped", usage: { cost: "unknown" } },
  ], 6), "subagents: 2/6 of 4 • $0.000+");
  assert.equal(formatSubagentSummary([{ status: "idle", usage: { cost: 0 } }, { status: "working" }], 4), "subagents: 1/4 of 2 • $0.000+");
});

test("summary shows live idle children, and omits that count at zero", () => {
  const working = { status: "working", pid: 1, usage: { cost: 7 } };
  const idle = (pid: number) => ({ status: "idle", pid, usage: { cost: 0 } });
  const stopped = { status: "stopped", usage: { cost: 0 } };
  assert.equal(formatSubagentSummary([
    working, idle(2), idle(3), stopped, stopped, stopped, stopped, stopped,
  ], 4), "subagents: 1(+2)/4 of 8 • $7.000");
  assert.equal(formatSubagentSummary([
    { status: "working", pid: 1, usage: { cost: 0 } },
    { status: "starting", pid: 2, usage: { cost: 0 } },
    stopped,
  ], 4), "subagents: 2/4 of 3 • $0.000");
});

test("summary labels an unlimited cap as infinity and a disabled cap as off", () => {
  const stopped = (cost: number) => ({ status: "stopped", usage: { cost } });
  assert.equal(formatSubagentSummary([stopped(1.234), stopped(0), stopped(0)], "unlimited"), "subagents: 0/∞ of 3 • $1.234");
  assert.equal(formatSubagentSummary([{ status: "stopped" }], 0), "subagents: 0/off of 1 • $0.000+");
  assert.equal(formatSubagentSummary([], "unlimited"), "");
  assert.equal(formatSubagentSummary([], 0), "");
});

test("right aligns dim lowercase status above the model and preserves stock rows", () => {
  const stock = [dim("~/Code/pi-packages (main)"), dim("usage stats                         model · medium"), "other extension"];
  const rendered = decorateFooter(stock, 120, label, dim);
  assert.equal(rendered.length, stock.length);
  assert.ok(stripVTControlCharacters(rendered[0]).endsWith(label));
  assert.equal(visibleWidth(rendered[0]), 120);
  assert.ok(rendered[0].includes(dim(label)));
  assert.deepEqual(rendered.slice(1), stock.slice(1));
  assert.equal(stock[0], dim("~/Code/pi-packages (main)"));
});

test("narrow widths preserve directory, add a bounded row, and handle unicode/ANSI", () => {
  for (const width of [1, 8, 20]) {
    const stock = ["界", "model"];
    const rendered = decorateFooter(stock, width, label, dim);
    assert.equal(rendered[0], stock[0]);
    assert.equal(rendered.at(-1), "model");
    assert.ok(visibleWidth(rendered[1]) <= width);
  }
  const rendered = decorateFooter([dim("界"), "model"], 60, label, dim);
  assert.equal(visibleWidth(rendered[0]), 60);
});

test("empty status or unexpected stock layout is unchanged", () => {
  const stock = ["cwd", "stats"];
  assert.equal(decorateFooter(stock, 80, "", dim), stock);
  const future = ["changed layout"];
  assert.equal(decorateFooter(future, 80, label, dim), future);
});

test("wrapper uses real renderer/receiver, current theme, and restores on disposal", () => {
  class Footer {
    constructor(readonly directory: string) {}
    render(_width: number) { return [this.directory, "stats"]; }
  }
  const original = Footer.prototype.render;
  let color = "a";
  const footer = new Footer("actual instance");
  const dispose = installFooterDecoration(Footer.prototype, () => label, text => `${color}:${text}`);
  try {
    assert.ok(footer.render(100)[0].includes("actual instance"));
    assert.ok(footer.render(100)[0].endsWith(`a:${label}`));
    color = "b";
    assert.ok(footer.render(100)[0].endsWith(`b:${label}`));
  } finally { dispose(); }
  assert.equal(Footer.prototype.render, original);
});

test("cleanup doesn't clobber later wrappers; cosmetic errors fall back to stock", () => {
  const prototype = { render: (_width: number) => ["cwd", "stats"] };
  const dispose = installFooterDecoration(prototype, () => { throw new Error("bad label"); }, dim);
  assert.deepEqual(prototype.render(80), ["cwd", "stats"]);
  const wrapped = prototype.render;
  prototype.render = width => [...wrapped(width), "later extension"];
  const later = prototype.render;
  dispose();
  assert.equal(prototype.render, later);
  assert.deepEqual(prototype.render(80), ["cwd", "stats", "later extension"]);
});
