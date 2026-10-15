import assert from "node:assert/strict";
import { test } from "node:test";
import todo from "../extensions/todo/index.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; exposure?: string; execute: (...args: unknown[]) => Promise<any> };

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
  const emit = async (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  return { tools, tool, call, emit, entries, renderers, ui, setAllTools: (names: string[]) => { allTools = names.map(name => ({ name })); } };
}

const text = (result: { content: { text: string }[] }) => result.content.map(part => part.text).join("\n");
const snapshot = (items: unknown[]) => ({ type: "custom", customType: "todo", data: { items } });

test("each change answers with the complete list as text and as structured content, and is persisted", async () => {
  const h = harness();
  const result = await h.call({ op: "set", items: ["Frame", "Fan out"] });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Set 2 items\.\nTodo: 0 done, 0 skipped, 0 in progress, 2 pending\n\[ \] 1\. Frame\n\[ \] 2\. Fan out/);
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
  assert.deepEqual(h.ui.widgets.at(-1), ["todo", ["Todo: 0 done, 0 skipped, 0 in progress, 1 pending", "[ ] 1. Frame"]]);
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

test("the tool is direct and its entries render in the transcript", () => {
  const h = harness();
  assert.equal(h.tool().name, "todo");
  assert.equal(h.tool().exposure ?? "direct", "direct");
  assert.deepEqual(h.renderers, ["todo"]);
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
