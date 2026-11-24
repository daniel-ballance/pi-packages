import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession, type BoundaryResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import todo from "../extensions/todo/index.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; description: string; promptSnippet: string; exposure?: string; execute: (...args: unknown[]) => Promise<any>; renderResult?: (...args: unknown[]) => unknown };

function harness({ hasUI = true, mode = "tui", branch = [] as unknown[], extensions = [todo] } = {}) {
  const tools: Tool[] = [], entries: { customType: string; data: unknown }[] = [], renderers: string[] = [];
  const handlers = new Map<string, Handler[]>();
  const ui = { widgets: [] as unknown[], statuses: [] as unknown[], notices: [] as unknown[] };
  let allTools: { name: string }[] = [];
  const pi = {
    registerTool: (tool: Tool) => { tools.push(tool); },
    registerEntryRenderer: (customType: string) => { renderers.push(customType); },
    appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); },
    on: (name: string, handler: Handler) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    getAllTools: () => allTools,
  };
  const uiApi = {
    setWidget: (key: string, lines: unknown) => ui.widgets.push([key, lines]),
    setStatus: (key: string, value: string | undefined) => ui.statuses.push([key, value]),
    notify: (message: string, type: string) => ui.notices.push([message, type]),
  };
  const ctx = {
    hasUI, mode,
    get ui() { if (!hasUI) throw new Error("touched ui without UI"); return uiApi; },
    sessionManager: { getBranch: () => branch },
  };
  for (const extension of extensions) extension(pi as never);
  const tool = () => tools.at(-1)!;
  const call = (params: unknown) => tool().execute("call-1", params, undefined, undefined, ctx);
  const emit = async (name: string, event = {}) => {
    const out: any[] = [];
    let proposal: BoundaryResult = { entries: [], continue: false };
    for (const handler of handlers.get(name) ?? []) {
      const boundary = name === "turn_end" || name === "agent_before_settle";
      const result = await handler(boundary ? { ...event, ...proposal } : event, ctx);
      if (result) {
        // Pi replaces each returned field and gives the next handler the resulting proposal.
        proposal = { ...proposal, ...result };
        out.push(proposal);
      }
    }
    return out;
  };
  return { tools, tool, call, emit, entries, renderers, ui, setAllTools: (names: string[]) => { allTools = names.map(name => ({ name })); } };
}

const settle = (outcome = "completed", canContinue = true) => ({ outcome, context: { canContinue } });
const turn = (...tools: string[]) => ({ toolResults: tools.map(toolName => ({ toolName })) });
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text };
const text = (result: { content: { text: string }[] }) => result.content.map(part => part.text).join("\n");
const snapshot = (items: unknown[]) => ({ type: "custom", customType: "todo", data: { items } });

test("set returns the complete list as text and as structured content, and each change is persisted", async () => {
  const h = harness();
  const result = await h.call({ op: "set", items: ["Frame", "Fan out"] });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /^Set 2 items\.\nUpdate items as you finish them: .*ids for several.*tools\.todo.*\nTodo: 0 done, 0 skipped, 0 in progress, 2 pending\n\[ \] 1\. Frame\n\[ \] 2\. Fan out/s);
  assert.deepEqual(result.structuredContent.counts, { pending: 2, in_progress: 0, done: 0, skipped: 0 });
  assert.equal(result.structuredContent.items.length, 2);
  assert.deepEqual(h.entries, [{ customType: "todo", data: { items: [{ id: 1, text: "Frame", state: "pending" }, { id: 2, text: "Fan out", state: "pending" }], nextId: 3 } }]);
  await h.call({ op: "update", id: 1, state: "in_progress" });
  assert.equal(h.entries.length, 2);
  assert.equal(text(await h.call({ op: "get" })).split("\n")[0], "Todo: 0 done, 0 skipped, 1 in progress, 1 pending");
  assert.equal(h.entries.length, 2, "get persists nothing");
});

test("incremental changes return counts and only open rows; get, errors and structured results retain resolved rows", async () => {
  const h = harness();
  await h.call({ op: "set", items: ["Frame", "Fan out", "Review"] });
  await h.call({ op: "update", id: 1, state: "done" });
  await h.call({ op: "update", id: 3, state: "in_progress" });
  const updated = await h.call({ op: "update", id: 2, state: "skipped", note: "single slice" });
  const added = await h.call({ op: "add", items: ["Duplicate"] });
  const removed = await h.call({ op: "remove", id: 4 });
  const counts = "Todo: 1 done, 1 skipped, 1 in progress, 0 pending";
  assert.equal(text(updated), `Item 2 is skipped.\n${counts}\n[>] 3. Review`);
  assert.equal(text(added), "Added item 4.\nTodo: 1 done, 1 skipped, 1 in progress, 1 pending\n[>] 3. Review\n[ ] 4. Duplicate");
  assert.equal(text(removed), `Removed item 4.\n${counts}\n[>] 3. Review`);
  for (const result of [updated, added, removed]) {
    assert.deepEqual(result.structuredContent.items.slice(0, 2), [
      { id: 1, text: "Frame", state: "done" }, { id: 2, text: "Fan out", state: "skipped", note: "single slice" },
    ]);
    assert.deepEqual(result.details.items, result.structuredContent.items);
  }
  const full = `${counts}\n[x] 1. Frame\n[-] 2. Fan out (skip: single slice)\n[>] 3. Review`;
  assert.equal(text(await h.call({ op: "get" })), full);
  for (const params of [{ op: "update", id: 1 }, { op: "remove", id: 9 }]) {
    const error = await h.call(params);
    assert.equal(error.isError, true);
    assert.ok(text(error).endsWith(full));
  }
  await h.call({ op: "set", items: ["Duplicate"] });
  assert.equal(text(await h.call({ op: "remove", id: 1 })), "Removed item 1.\nTodo: 0 done, 0 skipped, 0 in progress, 0 pending");
});

test("a resumed list keeps numbering after removed items, and older snapshots number from their highest item", async () => {
  const h = harness();
  await h.call({ op: "set", items: ["Frame", "Fan out"] });
  await h.call({ op: "remove", id: 2 });
  const resumed = harness({ branch: h.entries.map(entry => ({ type: "custom", ...entry })) });
  await resumed.emit("session_start");
  assert.match(text(await resumed.call({ op: "add", items: ["Report"] })), /^Added item 3\./);
  const older = harness({ branch: [snapshot([{ id: 1, text: "Frame", state: "done" }, { id: 4, text: "Report", state: "pending" }] as never)] });
  await older.emit("session_start");
  assert.match(text(await older.call({ op: "add", items: ["Ship"] })), /^Added item 5\./);
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

test("a malformed snapshot is ignored as a whole, preserving the last valid items and next id", async () => {
  const item = { id: 4, state: "pending", text: "Keep" };
  const valid = { type: "custom", customType: "todo", data: { items: [item], nextId: 9 } };
  for (const bad of [
    { items: [null] }, null, {}, { items: "not an array" }, { items: [item, { ...item, id: 1.5 }] },
    { items: [item, item] }, { items: [{ ...item, text: " " }] }, { items: [{ ...item, state: "unknown" }] },
    { items: [{ ...item, note: 7 }] }, { items: [{ ...item, state: "skipped" }] },
    { items: [item], nextId: 4 }, { items: [], nextId: "9" },
  ]) {
    const branch = [valid, { ...valid, data: bad }];
    const h = harness({ hasUI: false, branch });
    await h.emit("session_start");
    assert.deepEqual((await h.call({ op: "get" })).structuredContent.items, [item]);
    assert.match(text(await h.call({ op: "add", items: ["Next"] })), /^Added item 9\./);
    branch.shift();
    await h.emit("session_tree");
    assert.equal(text(await h.call({ op: "get" })), "Todo: no items", "no valid snapshot on this branch");
  }
});

test("the widget shows open work, clears when nothing is open, and no UI is touched without one", async () => {
  const h = harness();
  await h.call({ op: "set", items: ["Frame"] });
  if (process.env.T3_MCP_URL) {
    assert.deepEqual(h.ui.widgets, [], "the terminal widget stays inert even if T3 reports tui mode");
    assert.deepEqual(h.ui.statuses.at(-1), ["todo", "todo 0/1 · next: Frame"]);
    await h.call({ op: "update", id: 1, state: "done" });
    assert.deepEqual(h.ui.statuses.at(-1), ["todo", undefined]);
  } else {
    const [key, widget] = h.ui.widgets.at(-1) as [string, (tui: unknown, theme: unknown) => { render(width: number): string[] }];
    assert.equal(key, "todo");
    assert.deepEqual(widget(undefined, plainTheme).render(80), [" Todo ──────────── 0/1", "  ○ 1. Frame"]);
    await h.call({ op: "update", id: 1, state: "done" });
    assert.deepEqual(h.ui.widgets.at(-1), ["todo", undefined]);
    assert.deepEqual(h.ui.statuses, []);
  }
  const headless = harness({ hasUI: false, mode: "print" });
  await headless.call({ op: "set", items: ["Frame"] });
  await headless.call({ op: "update", id: 1, state: "in_progress" });
  await headless.emit("agent_end");
  assert.equal(headless.entries.length, 2);
});

test("RPC shows resolved/total and a bounded next step in a status, including after tree navigation", async () => {
  const branch = [snapshot([{ id: 1, state: "pending", text: "Frame" }])];
  const h = harness({ mode: "rpc", branch });
  await h.emit("session_start");
  assert.deepEqual(h.ui.statuses.at(-1), ["todo", "todo 0/1 · next: Frame"]);
  await h.call({ op: "add", items: ["Review\n" + "🙂".repeat(64)] });
  await h.call({ op: "update", id: 1, state: "skipped", note: "no longer needed" });
  assert.deepEqual(h.ui.statuses.at(-1), ["todo", "todo 1/2 · next: Review " + "🙂".repeat(53)]);
  const changes = h.ui.statuses.length;
  await h.call({ op: "update", id: 2, note: "still waiting" });
  assert.equal(h.ui.statuses.length, changes, "no duplicate status for a note-only change");
  await h.call({ op: "update", id: 2, state: "done" });
  assert.deepEqual(h.ui.statuses.at(-1), ["todo", undefined]);
  await h.emit("session_tree");
  assert.deepEqual(h.ui.statuses.at(-1), ["todo", "todo 0/1 · next: Frame"]);
  branch.length = 0;
  await h.emit("session_tree");
  assert.deepEqual(h.ui.statuses.at(-1), ["todo", undefined]);
  assert.deepEqual(h.ui.widgets, [], "RPC ignores component factories");
});

test("a run that ends with work in progress raises no warning: the widget already shows it", async () => {
  const h = harness();
  await h.call({ op: "set", items: ["Frame", "Fan out"] });
  await h.call({ op: "update", id: 2, state: "in_progress" });
  await h.emit("agent_end");
  assert.deepEqual(h.ui.notices, []);
});

test("the tool is direct, and the feed shows each change once, as a one-line tool call", async () => {
  const h = harness();
  assert.equal(h.tool().name, "todo");
  assert.equal(h.tool().exposure ?? "direct", "direct");
  assert.deepEqual(h.renderers, [], "stored snapshots are not drawn in the transcript");
  const theme = plainTheme as never;
  const render = (output: unknown, expanded: boolean) =>
    (h.tool().renderResult!(output as never, { expanded, isPartial: false } as never, theme, {} as never) as { render(width: number): string[] }).render(200).map(line => line.trimEnd()).filter(Boolean);
  await h.call({ op: "set", items: ["Frame", "Fan out"] });
  const output = await h.call({ op: "update", id: 1, state: "done" });
  assert.deepEqual(render(output, false), ["Item 1 is done. · 1/2 resolved"]);
  assert.deepEqual(render(output, true), ["Item 1 is done.", "Todo ━━━━━━────── 1/2", " ✓ 1. Frame", " ○ 2. Fan out"], "expanded shows the list");
  const failed = await h.call({ op: "update", id: 9, state: "done" });
  assert.equal(render(failed, false).length, 1);
});

test("tool guidance does not repeat the name Pi prefixes or the operation descriptions", () => {
  const { description, promptSnippet } = harness().tool();
  assert.doesNotMatch(promptSnippet, /^todo:/i);
  assert.doesNotMatch(description, /set replaces the list|add appends items|copy a playbook's steps verbatim/i);
});

test("under T3 a todo-like catalog name never hides the task tracker or registers it twice", async () => {
  const previous = process.env.T3_MCP_URL;
  process.env.T3_MCP_URL = "http://127.0.0.1:1/mcp";
  try {
    const h = harness();
    for (const catalog of [["mcp__t3-code__delegate_task"], ["mcp__t3-code__list_todo_templates"], []]) {
      h.setAllTools(catalog);
      await h.emit("before_agent_start");
      assert.equal(h.tools.length, 1);
      assert.equal(h.tool().exposure ?? "direct", "direct");
    }
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

for (const peerFirst of [true, false]) {
  test(`the reminder preserves entries from a handler registered ${peerFirst ? "before" : "after"} todo`, async () => {
    const entry = { type: "custom" as const, customType: "peer-report", data: { id: 7 } };
    const peer = (pi: ExtensionAPI) => {
      pi.on("turn_end", event => ({ entries: [...event.entries, entry], continue: true }));
    };
    const h = harness({ extensions: peerFirst ? [peer, todo] : [todo, peer] });
    await h.call({ op: "set", items: ["Review"] });
    await h.emit("turn_end", turn("todo"));
    const work = { toolResults: [{ toolName: "read" }] };
    for (let i = 0; i < 3; i++) await h.emit("turn_end", work);
    const reminder = (await h.emit("turn_end", work)).at(-1);
    assert.deepEqual(reminder.entries.map((e: { customType: string }) => e.customType), peerFirst ? ["peer-report", "todo-reminder"] : ["todo-reminder", "peer-report"]);
    assert.deepEqual(reminder.entries[peerFirst ? 0 : 1], entry);
    assert.equal(reminder.continue, true);
  });
}

test("after a few turns without a todo call, open items get one hidden reminder", async () => {
  const h = harness(), idle = { toolResults: [{ toolName: "bash" }] };
  await h.emit("before_agent_start", { messageType: "user" });
  await h.call({ op: "set", items: ["Frame", "Fan out"] });
  await h.emit("turn_end", turn("todo"));
  for (let turn = 1; turn < 4; turn++) assert.deepEqual(await h.emit("turn_end", idle), [], `turn ${turn}`);
  const [reminder] = await h.emit("turn_end", idle);
  assert.equal(reminder.entries[0].display, false);
  assert.match(reminder.entries[0].content, /^<todo-extension-note>\nAutomated note from the todo tool's extension, not from the user, who does not see it\. Do not mention it or reply to it\.\ntodo: 0\/2 resolved; next open: 1\. Frame\. Mark items done or skipped.*\n<\/todo-extension-note>$/);
  assert.deepEqual(await h.emit("turn_end", idle), [], "once until the next todo call");
  await h.call({ op: "update", id: 1, state: "done" });
  await h.emit("turn_end", turn("todo", "read"));
  for (let i = 0; i < 6; i++) assert.deepEqual(await h.emit("turn_end", turn()), [], "tool-less turns are not work");
  for (let i = 1; i < 4; i++) assert.deepEqual(await h.emit("turn_end", idle), []);
  assert.match((await h.emit("turn_end", idle))[0].entries[0].content, /1\/2 resolved; next open: 2\. Fan out/);
  await h.call({ op: "update", id: 2, state: "done" });
  for (let turn = 0; turn < 6; turn++) assert.deepEqual(await h.emit("turn_end", idle), [], "nothing open, nothing to say");
});

test("codemode counts its actual nested calls, not the script wrapper", async () => {
  const h = harness();
  const script = (...tools: string[]) => ({ toolResults: [{ toolName: "codemode", nestedCalls: {
    calls: tools.map((name, i) => ({ id: `script/${i + 1}`, name, status: "ok" })), complete: true,
  } }] });
  await h.call({ op: "set", items: ["Review"] });
  await h.emit("turn_end", script("todo"));
  for (let i = 1; i < 4; i++) assert.deepEqual(await h.emit("turn_end", turn("read")), []);
  assert.equal((await h.emit("turn_end", script("read"))).length, 1, "the fourth work turn can be a script");
  await h.call({ op: "get" }); // The nested call runs execute() as well.
  await h.emit("turn_end", script("read", "todo"));
  for (let i = 1; i < 4; i++) assert.deepEqual(await h.emit("turn_end", turn("read")), [], "a script that ran todo resets the count");
  assert.equal((await h.emit("turn_end", turn("read"))).length, 1);
});

test("a script that ran todo is still a todo turn if the nested-call record omits it", async () => {
  const h = harness();
  await h.call({ op: "set", items: ["Wait for the report"] });
  // Pi caps the nested-call record; a call that actually ran can be missing.
  await h.emit("turn_end", { toolResults: [{ toolName: "codemode", nestedCalls: {
    calls: [{ id: "script/1", name: "read", status: "ok" }], complete: false,
  } }] });
  for (let i = 1; i < 4; i++) assert.deepEqual(await h.emit("turn_end", turn("read")), []);
  assert.equal((await h.emit("turn_end", turn("read"))).length, 1);
});

test("each new request starts a fresh four-work-turn reminder interval for the open list", async () => {
  const h = harness();
  await h.call({ op: "set", items: ["Review"] });
  await h.emit("turn_end", turn("todo"));
  await h.emit("turn_end", turn("read"));
  for (const messageType of ["user", "custom"]) {
    await h.emit("before_agent_start", { messageType });
    for (let i = 0; i < 3; i++) assert.deepEqual(await h.emit("turn_end", turn("read")), []);
    assert.equal((await h.emit("turn_end", turn("read"))).length, 1);
  }
});

test("a run that ends with open items gets no extra turn", async () => {
  const h = harness();
  await h.emit("before_agent_start", { messageType: "user" });
  await h.call({ op: "set", items: ["Frame", "Report"] });
  await h.emit("turn_end", turn("todo", "bash"));
  await h.emit("turn_end", turn("read"));
  assert.deepEqual(await h.emit("agent_before_settle", settle()), []);
  assert.doesNotMatch(text(await h.call({ op: "update", id: 1, state: "done" })), /end your turn/i);
});
