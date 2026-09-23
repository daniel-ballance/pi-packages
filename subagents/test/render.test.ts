import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import subagents from "../index.js";
import { subagentRenderers } from "../src/render.js";

type Action = Parameters<typeof subagentRenderers>[0];
type RenderContext = Parameters<ReturnType<typeof subagentRenderers>["renderResult"]>[3];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const context = (isError = false) => ({ isError }) as RenderContext;
const child = {
  id: "subagent-12345678", name: "footer-smoke-test", status: "idle", model: "openai-codex/gpt-5.6-luna", thinking: "high",
  task: "Return a short answer", sessionFile: "/private/session.jsonl", logFile: "/private/events.jsonl",
  usage: { assistantMessages: 1, cost: 0.125, tokens: { input: 484, output: 9 }, contextUsage: { percent: 0.2, contextWindow: 272000 }, autoCompaction: true },
};
function result(details: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details }; }
function render(action: Action, details: unknown, expanded = false, width = 120) {
  return subagentRenderers(action).renderResult(result(details), { expanded, isPartial: false }, theme, context()).render(width).join("\n");
}

test("all subagent tools register call/result renderers without changing execution schemas", () => {
  const tools: ToolDefinition[] = [];
  subagents({ on() {}, registerCommand() {}, registerTool(tool: ToolDefinition) { tools.push(tool); } } as unknown as ExtensionAPI);
  assert.equal(tools.length, 10);
  for (const tool of tools) {
    assert.equal(typeof tool.renderCall, "function", tool.name);
    assert.equal(typeof tool.renderResult, "function", tool.name);
    assert.equal(typeof tool.execute, "function", tool.name);
  }
});

test("spawn shows a compact identity, status, model, usage and task instead of raw JSON", () => {
  const rendered = render("spawn", { ...child, status: "working" });
  assert.match(rendered, /● working  footer-smoke-test  subagent-12345678/);
  assert.match(rendered, /gpt-5.6-luna:high · 1 turn/);
  assert.match(rendered, /↑484 ↓9 \$0.125 0.2%\/272k \(auto\)/);
  assert.match(rendered, /Task: Return a short answer/);
  assert.doesNotMatch(rendered, /sessionFile|\/private|"usage"/);
  assert.ok(rendered.split("\n").length <= 5);
  assert.match(rendered, /expand for details/);
});

test("expanded output retains full raw diagnostics and does not mutate the tool result", () => {
  const data = result(child);
  const before = JSON.stringify(data);
  const renderer = subagentRenderers("spawn");
  const expanded = renderer.renderResult(data, { expanded: true, isPartial: false }, theme, context()).render(120).join("\n");
  assert.match(expanded, /Full result/);
  assert.match(expanded, /"sessionFile": "\/private\/session.jsonl"/);
  assert.match(expanded, /"logFile": "\/private\/events.jsonl"/);
  assert.equal(JSON.stringify(data), before);
});

test("read foregrounds the latest assistant reply, not lifecycle and sent echoes", () => {
  const details = { id: child.id, name: child.name, status: "idle", sessionFile: child.sessionFile, updates: [
    { kind: "lifecycle", text: "Child ready: internal metadata" },
    { kind: "sent", text: "Return a short answer" },
    { kind: "assistant", text: "Ready for footer inspection." },
  ] };
  const collapsed = render("read", details);
  assert.match(collapsed, /Ready for footer inspection\./);
  assert.doesNotMatch(collapsed, /internal metadata|Return a short answer|sessionFile/);
  assert.match(render("read", details, true), /internal metadata/);
  assert.match(render("read", { ...details, updates: [] }), /No new updates/);
});

test("read keeps failures, pending dialogs, history gaps and pagination visible", () => {
  const text = render("read", { ...child, status: "waiting_input", gap: true, hasMore: true,
    uiRequests: [{ id: "ui-1", method: "confirm", title: "Approve?" }],
    updates: [{ kind: "error", text: "Provider quota exceeded" }, { kind: "assistant", text: "Partial reply" }],
  });
  for (const value of ["needs input", "pending input", "History gap", "More unread", "Provider quota exceeded", "Partial reply"]) assert.ok(text.includes(value), value);
  const failed = render("abort", { ...child, status: "failed", aborted: true, error: "Unrelated provider failure" });
  assert.match(failed, /✗ failed/);
  assert.doesNotMatch(failed, /cancelled/);
  assert.match(render("abort", { ...child, aborted: true }), /cancelled/);
});

test("catalog summarizes capabilities without dumping policy guidance", () => {
  const catalog = { spawnEnabled: true, models: [{ id: "test/model:high", description: "Long model guidance hidden until expansion" }], tools: ["read", "bash"], maxChildren: 4, source: "/private/policy.json", omittedEntries: 2 };
  const text = render("catalog", catalog);
  assert.match(text, /Ready to spawn · 1 model options · 2 tools · max 4 children/);
  assert.match(text, /test\/model:high/);
  assert.match(text, /Tools: read, bash/);
  assert.match(text, /2 unavailable option/);
  assert.doesNotMatch(text, /Long model guidance|\/private/);
  assert.match(render("catalog", catalog, true), /Long model guidance/);
  assert.match(render("catalog", { spawnEnabled: false, error: "Invalid policy" }), /Spawning disabled[\s\S]*Invalid policy/);
});

test("wait and list distinguish timeouts, input needs and missing aggregate costs", () => {
  assert.match(render("wait", { timedOut: true, agents: [{ ...child, status: "working" }] }), /Wait timed out[\s\S]*working/);
  assert.match(render("wait", { timedOut: false, needsInput: true, agents: [{ ...child, status: "waiting_input" }] }), /Input required[\s\S]*needs input/);
  assert.match(render("list", { totals: { active: 1, tracked: 2, reportedCost: 0.125, missingCost: 1 }, agents: [child] }), /1 active \/ 2 tracked · \$0.125 · 1 cost unknown/);
  assert.match(render("list", { agents: [] }), /No subagents tracked/);
  const agents = [...Array.from({ length: 4 }, () => child), { ...child, status: "failed" }];
  assert.match(render("list", { agents }), /1 more children \(1 need attention\)/);
});

test("plain errors, partial results and spilled results remain intelligible", () => {
  const renderer = subagentRenderers("spawn");
  const error = { content: [{ type: "text" as const, text: "Live-child limit reached" }], details: undefined };
  const text = renderer.renderResult(error, { expanded: false, isPartial: false }, theme, context(true)).render(80).join("\n");
  assert.match(text, /Live-child limit reached/);
  const partial = renderer.renderResult(result(child), { expanded: false, isPartial: true }, theme, context()).render(80).join("\n");
  assert.equal(partial, "Updating…");
  const spilled = render("read", { fullResult: "/private/overflow.json" });
  assert.match(spilled, /Result truncated/);
  assert.match(spilled, /\/private\/overflow.json/);
  assert.doesNotMatch(spilled, /No new updates/);
  assert.match(render("read", null), /null/);
});

test("renderers handle partial arguments and use bounded call headers", () => {
  for (const action of ["catalog", "spawn", "list", "send", "read", "wait", "abort", "close", "resume", "respond"] as const) {
    const call = subagentRenderers(action).renderCall({}, theme, context());
    assert.equal(call.render(60).length, 1);
    assert.ok(visibleWidth(call.render(10)[0]) <= 10);
  }
});

test("collapsed previews are bounded in physical rows and strip child terminal controls", () => {
  const hostile = { ...child, name: "审查🙂\x1b[2J\x1b]0;fake-title\x07\nspoof", updates: [{ kind: "assistant", text: ("Wide 界🙂 output\t\x1b[31m\x00\n").repeat(200) }] };
  const data = result(hostile);
  for (const width of [1, 2, 20, 40, 80, 120]) {
    const component = subagentRenderers("read").renderResult(data, { expanded: false, isPartial: false }, theme, context());
    const lines = component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.length <= 10);
    // Pi's truncator adds its own SGR resets; child escapes must not survive.
    assert.doesNotMatch(lines.join(""), /\x1b\[2J|\x1b\[31m|fake-title|\x00/);
    component.invalidate();
    assert.deepEqual(component.render(width), lines);
    assert.deepEqual(component.render(0), []);
  }
  assert.match(render("read", hostile, false, 80), /more in details/);
  const expanded = render("read", hostile, true, 40).split("\n");
  assert.ok(expanded.every(line => visibleWidth(line) <= 40));
});

test("Pi's tool execution shell uses the custom views and expands the original payload", () => {
  initTheme("dark", false);
  const ui = { requestRender() {} } as TUI;
  const tool = new ToolExecutionComponent("subagent_spawn", "call-1", { name: child.name }, {}, subagentRenderers("spawn"), ui, "/tmp");
  tool.markExecutionStarted();
  tool.setArgsComplete();
  tool.updateResult({ ...result(child), isError: false });
  const collapsed = tool.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(collapsed, /Spawn subagent/);
  assert.match(collapsed, /footer-smoke-test/);
  assert.doesNotMatch(collapsed, /sessionFile/);
  tool.setExpanded(true);
  const expanded = tool.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(expanded, /Full result/);
  assert.match(expanded, /sessionFile/);
  tool.setExpanded(false);
  tool.updateResult({ content: [{ type: "text", text: "Spawn rejected" }], isError: true });
  assert.match(tool.render(80).map(stripVTControlCharacters).join("\n"), /Spawn rejected/);
  for (const width of [20, 40, 80, 120]) assert.ok(tool.render(width).every(line => visibleWidth(line) <= width));
});

test("theme styling is rebuilt during render rather than cached permanently", () => {
  let color = "31";
  const changingTheme = { fg: (_name: string, value: string) => `\x1b[${color}m${value}\x1b[0m`, bold: (value: string) => value } as Theme;
  const component = subagentRenderers("close").renderResult(result({ ...child, status: "stopped" }), { expanded: false, isPartial: false }, changingTheme, context());
  const before = component.render(80);
  color = "32"; component.invalidate();
  const after = component.render(80);
  assert.notDeepEqual(after, before);
  assert.deepEqual(after.map(stripVTControlCharacters), before.map(stripVTControlCharacters));
});
