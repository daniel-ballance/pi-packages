import assert from "node:assert/strict";
import { test } from "node:test";
import todo from "../extensions/todo/index.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; exposure?: string; execute: (...args: unknown[]) => Promise<any>; renderResult?: (...args: unknown[]) => unknown };

function harness({ hasUI = true, branch = [] as unknown[] } = {}) {
  const tools: Tool[] = [], entries: { customType: string; data: unknown }[] = [], renderers: string[] = [];
  const handlers = new Map<string, Handler[]>();
  const ui = { widgets: [] as unknown[], notices: [] as unknown[] };
  let allTools: { name: string }[] = [];
  const pi = {
    registerTool: (tool: Tool) => { tools.push(tool); },
    registerEntryRenderer: (customType: string) => { renderers.push(customType); },
    appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); },
    on: (name: string, handler: Handler) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    getAllTools: () => allTools,
  };
  const uiApi = { setWidget: (key: string, lines: unknown) => ui.widgets.push([key, lines]), notify: (message: string, type: string) => ui.notices.push([message, type]) };
  const ctx = {
    hasUI,
    get ui() { if (!hasUI) throw new Error("touched ui without UI"); return uiApi; },
    sessionManager: { getBranch: () => branch },
  };
  todo(pi as never);
  const tool = () => tools.at(-1)!;
  const call = (params: unknown) => tool().execute("call-1", params, undefined, undefined, ctx);
  const emit = async (name: string, event: unknown = {}) => { const out: any[] = []; for (const handler of handlers.get(name) ?? []) out.push(await handler(event, ctx)); return out.filter(Boolean); };
  return { tools, tool, call, emit, entries, renderers, ui, setAllTools: (names: string[]) => { allTools = names.map(name => ({ name })); } };
}

const text = (result: { content: { text: string }[] }) => result.content.map(part => part.text).join("\n");
const snapshot = (items: unknown[]) => ({ type: "custom", customType: "todo", data: { items } });

test("each change answers with the complete list as text and as structured content, and is persisted", async () => {
  const h = harness();
  const result = await h.call({ op: "set", items: ["Frame", "Fan out"] });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /^Set 2 items\.\nUpdate items as you finish them: .*ids for several.*tools\.todo.*\nTodo: 0 done, 0 skipped, 0 in progress, 2 pending\n\[ \] 1\. Frame\n\[ \] 2\. Fan out/s);
  assert.deepEqual(result.structuredContent.counts, { pending: 2, in_progress: 0, done: 0, skipped: 0 });
  assert.equal(result.structuredContent.items.length, 2);
  assert.deepEqual(h.entries, [{ customType: "todo", data: { items: [{ id: 1, text: "Frame", state: "pending" }, { id: 2, text: "Fan out", state: "pending" }] } }]);
  await h.call({ op: "update", id: 1, state: "in_progress" });
  assert.equal(h.entries.length, 2);
  assert.equal(text(await h.call({ op: "get" })).split("\n")[0], "Todo: 0 done, 0 skipped, 1 in progress, 1 pending");
  assert.equal(h.entries.length, 2, "get persists nothing");
});

test("a rejected operation is an error result that changes and persists nothing", async () => {
  const h = harness();
  await h.call({ op: "set", items: ["Frame"] });
  const result = await h.call({ op: "update", id: 1, state: "skipped" });
  assert.equal(result.isError, true);
  assert.match(text(result), /needs a reason/);
  assert.match(text(result), /\[ \] 1\. Frame/, "the error still shows the unchanged list");
  assert.equal(h.entries.length, 1);
});

test("the list is rebuilt from the active branch on start and on tree navigation", async () => {
  const branch: unknown[] = [snapshot([{ id: 1, text: "Old", state: "done" }]), { type: "message" }, snapshot([{ id: 1, text: "New", state: "in_progress" }])];
  const h = harness({ branch });
  await h.emit("session_start");
  assert.match(text(await h.call({ op: "get" })), /\[>\] 1\. New/);
  branch.splice(1);
  await h.emit("session_tree");
  assert.match(text(await h.call({ op: "get" })), /\[x\] 1\. Old/);
});

test("the widget shows open work, clears when nothing is open, and no UI is touched without one", async () => {
  const h = harness();
  await h.call({ op: "set", items: ["Frame"] });
  assert.deepEqual(h.ui.widgets.at(-1), ["todo", ["Todo: 0/1 resolved", "[ ] 1. Frame"]]);
  await h.call({ op: "update", id: 1, state: "done" });
  assert.deepEqual(h.ui.widgets.at(-1), ["todo", undefined]);
  const headless = harness({ hasUI: false });
  await headless.call({ op: "set", items: ["Frame"] });
  await headless.call({ op: "update", id: 1, state: "in_progress" });
  await headless.emit("agent_end");
  assert.equal(headless.entries.length, 2);
});

test("a run that ends with work in progress says so", async () => {
  const h = harness();
  await h.call({ op: "set", items: ["Frame", "Fan out"] });
  await h.emit("agent_end");
  assert.deepEqual(h.ui.notices, []);
  await h.call({ op: "update", id: 2, state: "in_progress" });
  await h.emit("agent_end");
  assert.deepEqual(h.ui.notices, [["Todo: 1 item still in progress: 2. Fan out", "warning"]]);
});

test("the tool is direct, and the feed shows each change once, as a one-line tool call", async () => {
  const h = harness();
  assert.equal(h.tool().name, "todo");
  assert.equal(h.tool().exposure ?? "direct", "direct");
  assert.deepEqual(h.renderers, [], "stored snapshots are not drawn in the transcript");
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
  const render = (output: unknown, expanded: boolean) =>
    (h.tool().renderResult!(output as never, { expanded, isPartial: false } as never, theme, {} as never) as { render(width: number): string[] }).render(200).map(line => line.trimEnd()).filter(Boolean);
  await h.call({ op: "set", items: ["Frame", "Fan out"] });
  const output = await h.call({ op: "update", id: 1, state: "done" });
  assert.deepEqual(render(output, false), ["Item 1 is done. · 1/2 resolved"]);
  assert.ok(render(output, true).some(line => line.includes("2. Fan out")), "expanded shows the list");
  const failed = await h.call({ op: "update", id: 9, state: "done" });
  assert.equal(render(failed, false).length, 1);
});

test("under T3 the tool steps aside, to tool_search and codemode, only when T3 offers its own todo tool", async () => {
  const previous = process.env.T3_MCP_URL;
  process.env.T3_MCP_URL = "http://127.0.0.1:1/mcp";
  try {
    const h = harness();
    h.setAllTools(["mcp__t3-code__delegate_task"]);
    await h.emit("before_agent_start");
    assert.equal(h.tool().exposure ?? "direct", "direct");
    h.setAllTools(["mcp__t3-code__delegate_task", "mcp__t3-code__todo_write"]);
    await h.emit("before_agent_start");
    assert.equal(h.tool().exposure, "deferred");
    const registrations = h.tools.length;
    await h.emit("before_agent_start");
    assert.equal(h.tools.length, registrations, "re-registered once");
  } finally {
    if (previous === undefined) delete process.env.T3_MCP_URL; else process.env.T3_MCP_URL = previous;
  }
});

test("in a terminal, a tool that merely looks like T3's changes nothing", async () => {
  const previous = process.env.T3_MCP_URL;
  delete process.env.T3_MCP_URL;
  try {
    const h = harness();
    h.setAllTools(["mcp__t3-code__todo_write"]);
    await h.emit("before_agent_start");
    assert.equal(h.tool().exposure ?? "direct", "direct");
  } finally {
    if (previous !== undefined) process.env.T3_MCP_URL = previous;
  }
});

test("after a few turns without a todo call, open items get one hidden reminder", async () => {
  const h = harness();
  await h.emit("before_agent_start", { messageType: "user" });
  await h.call({ op: "set", items: ["Frame", "Fan out"] });
  for (let turn = 1; turn < 4; turn++) assert.deepEqual(await h.emit("turn_end"), [], `turn ${turn}`);
  const [reminder] = await h.emit("turn_end");
  assert.equal(reminder.entries[0].display, false);
  assert.match(reminder.entries[0].content, /^\[todo: 0\/2 resolved; next open: 1\. Frame\] Mark items done or skipped/);
  assert.deepEqual(await h.emit("turn_end"), [], "once until the next todo call");
  await h.call({ op: "update", id: 1, state: "done" });
  for (let turn = 1; turn < 4; turn++) await h.emit("turn_end");
  assert.match((await h.emit("turn_end"))[0].entries[0].content, /1\/2 resolved; next open: 2\. Fan out/);
  await h.call({ op: "update", id: 2, state: "done" });
  for (let turn = 0; turn < 6; turn++) assert.deepEqual(await h.emit("turn_end"), [], "nothing open, nothing to say");
});

test("a run that used the list and leaves items open gets one more turn to mark them", async () => {
  const settle = (outcome = "completed", canContinue = true) => ({ outcome, continue: false, entries: [], context: { canContinue } });
  const h = harness();
  await h.emit("before_agent_start", { messageType: "user" });
  assert.deepEqual(await h.emit("agent_before_settle", settle()), [], "no list: nothing to check");
  await h.call({ op: "set", items: ["Frame", "Report"] });
  await h.call({ op: "update", id: 1, state: "done" });
  const [nudge] = await h.emit("agent_before_settle", settle());
  assert.equal(nudge.continue, true);
  assert.equal(nudge.entries[0].display, false);
  assert.match(nudge.entries[0].content, /still has 1 open item: 2\. Report\. Mark each one done, or skipped .*say so in one line and stop/);
  assert.deepEqual(await h.emit("agent_before_settle", settle()), [], "once per request");
  await h.emit("agent_start");
  await h.call({ op: "update", id: 2, state: "in_progress" });
  assert.deepEqual(await h.emit("agent_before_settle", settle()), [], "the continuation it asked for is not nudged again");
  await h.emit("before_agent_start", { messageType: "user" });
  assert.deepEqual(await h.emit("agent_before_settle", settle()), [], "a later run that never touched the list is left alone");
  await h.call({ op: "get" });
  assert.deepEqual(await h.emit("agent_before_settle", settle("aborted")), [], "not after an abort");
  assert.equal((await h.emit("agent_before_settle", settle("completed", false))).length, 1, "a normal end has canContinue false; the hidden message is what continues");
});
