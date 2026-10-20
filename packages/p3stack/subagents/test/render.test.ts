import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { nativeTools } from "./native-tools.js";
import { subagentRenderers } from "../extensions/subagents/src/render.js";
import { WAKE_REASONS, type WakeReason } from "../extensions/subagents/src/wait.js";

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
function render(action: Action, details: unknown, expanded = false, width = 120, args?: Record<string, unknown>) {
  return subagentRenderers(action).renderResult(result(details), { expanded, isPartial: false }, theme, { ...context(), ...(args ? { args } : {}) }).render(width).join("\n");
}

test("all subagent tools register call/result renderers without changing execution schemas", () => {
  const tools = nativeTools();
  assert.equal(tools.length, 19);
  for (const tool of tools) {
    assert.equal(typeof tool.renderCall, "function", tool.name);
    assert.equal(typeof tool.renderResult, "function", tool.name);
    assert.equal(typeof tool.execute, "function", tool.name);
  }
});

test("peer renderers show directional budgets and receipt state with bounded widths", () => {
  const data = { links: [{ a: "A", b: "B", enabled: true, ab: { used: 1, limit: 2 }, ba: { used: 0, limit: 2 } }],
    messages: [{ sender: "A", recipient: "B", status: "received", id: "peer-123", message: "private body" }], gap: true, hasMore: true, nextCursor: 5 };
  const text = render("peers", data);
  assert.match(text, /A ↔ B · connected/); assert.match(text, /→ 1\/2 used · ← 0\/2 used/);
  assert.match(text, /received/); assert.match(text, /history gap/); assert.match(text, /cursor 5/);
  assert.doesNotMatch(text, /private body/);
  assert.match(render("peers", data, true), /private body/);
  assert.match(render("renew", { sender: "A", recipient: "B", generation: 2, remaining: 3 }), /generation 2 · 3 remaining/);
  for (const line of render("peers", data, false, 30).split("\n")) assert.ok(visibleWidth(line) <= 30);
});

test("spawn card shows name, state and model, and a short task line from the call", () => {
  const details = { id: child.id, name: child.name, status: "working", model: child.model, thinking: child.thinking, unread: 0 };
  const rendered = render("spawn", details, false, 120, { name: child.name, task: child.task, model: child.model, thinking: child.thinking });
  assert.match(rendered, /^● footer-smoke-test working {2,}gpt-5\.6-luna · high$/m);
  assert.match(rendered, /task: Return a short answer/);
  assert.doesNotMatch(rendered, /sessionFile|\/private|"usage"|1 turn/);
  assert.ok(rendered.split("\n").length <= 4);
  assert.match(rendered, /expand for details/);
  const long = render("spawn", details, false, 120, { task: `Return a short answer ${"x".repeat(2000)}` });
  assert.match(long, /task: Return a short answer/);
  assert.doesNotMatch(long, /x{90}/);
  assert.match(long, /footer-smoke-test working/);
  assert.match(long, /gpt-5\.6-luna · high/);
});

test("expanded output retains full raw diagnostics and does not mutate the tool result", () => {
  const data = result(child);
  const before = JSON.stringify(data);
  const renderer = subagentRenderers("spawn");
  const expanded = renderer.renderResult(data, { expanded: true, isPartial: false }, theme, context()).render(120).join("\n");
  assert.match(expanded, /full result/);
  assert.match(expanded, /"sessionFile": "\/private\/session.jsonl"/);
  assert.match(expanded, /"logFile": "\/private\/events.jsonl"/);
  assert.equal(JSON.stringify(data), before);
});

test("read foregrounds the latest assistant reply, not lifecycle and sent echoes", () => {
  const details = { id: child.id, name: child.name, status: "idle", model: child.model, thinking: child.thinking, sessionFile: child.sessionFile, updates: [
    { kind: "lifecycle", text: "Child ready: internal metadata" },
    { kind: "sent", text: "Return a short answer" },
    { kind: "assistant", text: "Ready for footer inspection." },
  ] };
  const collapsed = render("read", details);
  assert.match(collapsed, /^· footer-smoke-test stopped {2,}gpt-5\.6-luna · high$/m);
  assert.match(collapsed, /Ready for footer inspection\./);
  assert.doesNotMatch(collapsed, /internal metadata|Return a short answer|sessionFile/);
  assert.match(render("read", details, true), /internal metadata/);
  assert.match(render("read", { ...details, updates: [] }), /no new updates/);
});

test("read keeps failures, pending dialogs, history gaps and pagination visible", () => {
  const text = render("read", { ...child, status: "waiting_input", gap: true, hasMore: true,
    uiRequests: [{ id: "ui-1", method: "confirm", title: "Approve?" }],
    updates: [{ kind: "error", text: "Provider quota exceeded" }, { kind: "assistant", text: "Partial reply" }],
  });
  for (const value of ["needs input: Approve?", "history gap", "more unread", "Provider quota exceeded", "Partial reply"]) assert.ok(text.includes(value), value);
  const failed = render("abort", { ...child, status: "failed", aborted: true, error: "Unrelated provider failure" });
  assert.match(failed, /! footer-smoke-test failed/);
  assert.match(failed, /↳ Unrelated provider failure/);
  assert.doesNotMatch(failed, /cancelled/);
  assert.match(render("abort", { ...child, aborted: true }), /↳ cancelled · 1 turn/);
});

test("catalog summarizes capabilities without dumping policy guidance", () => {
  const catalog = { spawnEnabled: true, models: [{ id: "test/model:high", description: "Long model guidance hidden until expansion" }], tools: ["read", "bash"], maxChildren: 4, source: "/private/policy.json", omittedEntries: 2 };
  const text = render("catalog", catalog);
  assert.match(text, /ready to spawn · 1 model options · 2 tools · max 4 children/);
  assert.match(render("catalog", { ...catalog, maxChildren: "unlimited" }), /no child limit/);
  assert.match(render("catalog", { ...catalog, spawnEnabled: false, maxChildren: 0 }), /max 0 children/);
  assert.doesNotMatch(render("catalog", { ...catalog, maxChildren: -1 }), /max -1 children|no child limit/);
  assert.match(text, /test\/model:high/);
  assert.match(text, /tools: read, bash/);
  assert.match(text, /2 unavailable option/);
  assert.doesNotMatch(text, /Long model guidance|\/private/);
  assert.match(render("catalog", catalog, true), /Long model guidance/);
  assert.match(render("catalog", { spawnEnabled: false, error: "Invalid policy" }), /spawning disabled[\s\S]*Invalid policy/);
});

test("each wake reason but settled draws its banner above the children", () => {
  const banners: { [W in WakeReason]: RegExp | undefined } = {
    hold: /human hold/, input: /input required/, settled: undefined, child_message: /message from a child/, message: /message queued/, timeout: /wait timed out/,
  };
  const working = { id: child.id, name: child.name, status: "working", activity: "Tool: bash", unread: 0 };
  for (const wake of WAKE_REASONS) {
    const text = render("wait", { wake, agents: [working] });
    assert.match(text, /footer-smoke-test working/, wake);
    for (const [other, banner] of Object.entries(banners)) if (banner) assert.equal(banner.test(text), other === wake, `${wake}: ${other}`);
  }
});

test("a child_message wait previews the message of a child that is still working", () => {
  const working = { id: "sa-1", name: "scout", status: "working", unread: 0, reports: [{ kind: "message", text: "The API is v2, not v1: plan B." }] };
  const text = render("wait", { wake: "child_message", agents: [working] });
  assert.match(text, /message from a child/);
  assert.match(text, /scout \(message\): The API is v2, not v1: plan B\./);
  const read = render("read", { id: "sa-1", name: "scout", status: "working", updates: [{ cursor: 3, kind: "message", text: "Blocked on credentials." }] });
  assert.match(read, /message: Blocked on credentials\./);
});

test("a wait draws returned reports as reviewed with a preview, and counts the reports it did not show", () => {
  const done = { id: "sa-1", name: "review-types", status: "idle", unread: 0, resultReview: { status: "reviewed" },
    reports: [{ kind: "assistant", text: "Two findings." }] };
  const text = render("wait", { wake: "settled", agents: [done, { id: "sa-2", name: "docs", status: "idle", unread: 2, resultReview: { status: "unreviewed" } }] });
  assert.match(text, /✓ review-types reviewed/);
  assert.match(text, /review-types: Two findings\./);
  assert.match(text, /\* docs unread/);
  assert.match(text, /2 report\(s\) not shown · subagent_read/);
  assert.doesNotMatch(render("wait", { wake: "settled", agents: [done] }), /not shown/);
});

test("a wait result from before wake reasons still draws its children, and list shows missing aggregate costs", () => {
  assert.match(render("wait", { timedOut: true, agents: [{ ...child, status: "working" }] }), /footer-smoke-test working/);
  assert.match(render("list", { totals: { active: 1, tracked: 2, reportedCost: 0.125, missingCost: 1 }, agents: [child] }), /1 active \/ 2 tracked · \$0.125 · 1 cost unknown/);
  assert.match(render("list", { agents: [] }), /no subagents tracked/);
  const agents = [...Array.from({ length: 4 }, () => child), { ...child, status: "failed" }];
  assert.match(render("list", { agents }), /1 more children \(1 need attention\)/);
  assert.match(render("list", { agents: [...agents.slice(0, 4), { ...child, hold: { kind: "halt" } }] }), /1 more children \(1 need attention\)/);
});

test("plain errors, partial results and spilled results remain intelligible", () => {
  const renderer = subagentRenderers("spawn");
  const error = { content: [{ type: "text" as const, text: "Live-child limit reached" }], details: undefined };
  const text = renderer.renderResult(error, { expanded: false, isPartial: false }, theme, context(true)).render(80).join("\n");
  assert.match(text, /Live-child limit reached/);
  const partial = renderer.renderResult(result(child), { expanded: false, isPartial: true }, theme, context()).render(80).join("\n");
  assert.equal(partial, "updating…");
  const spilled = render("read", { fullResult: "/private/overflow.json" });
  assert.match(spilled, /result truncated/);
  assert.match(spilled, /\/private\/overflow.json/);
  assert.doesNotMatch(spilled, /no new updates/);
  assert.match(render("read", null), /null/);
});

test("renderers handle partial arguments and use bounded call headers", () => {
  for (const action of ["catalog", "spawn", "list", "send", "read", "wait", "abort", "close", "resume", "respond", "workflow-start", "workflow-inspect", "workflow-control"] as const) {
    const call = subagentRenderers(action).renderCall({}, theme, context());
    assert.equal(call.render(60).length, 1);
    assert.match(call.render(60)[0], /^subagents • /);
    assert.ok(visibleWidth(call.render(10)[0]) <= 10);
  }
});

test("call rows identify the package, then the thing, action and parameters", () => {
  const names = (kind: "child" | "workflow", id: string) => kind === "child" ? ({ "subagent-1": "footer-smoke-test", "subagent-2": "worker-b" } as Record<string, string>)[id] : id === "workflow-1" ? "autonomous repair" : undefined;
  const line = (action: Parameters<typeof subagentRenderers>[0], args: Record<string, unknown>) =>
    subagentRenderers(action, names).renderCall(args, theme, { argsComplete: true } as ReturnType<typeof context>).render(160)[0];
  assert.equal(line("catalog", {}), "subagents • catalog");
  assert.equal(line("list", { includeRejected: true }), "subagents • list rejected");
  assert.equal(line("spawn", { name: "footer-smoke-test", task: "Return a short answer", model: "openai-codex/gpt-5.6-luna", thinking: "high" }),
    "subagents • footer-smoke-test • spawn Return a short answer openai-codex/gpt-5.6-luna:high");
  assert.equal(line("send", { id: "subagent-1", message: "Return a short answer", behavior: "steer" }),
    "subagents • footer-smoke-test • send Return a short answer (steer)");
  assert.equal(line("read", { id: "subagent-1", since: 12 }), "subagents • footer-smoke-test • read (since 12)");
  assert.equal(line("wait", { ids: ["subagent-1"], timeoutSeconds: 10 }), "subagents • footer-smoke-test • wait 10s");
  assert.equal(line("wait", { ids: ["subagent-1", "subagent-2"], timeoutSeconds: 10 }), "subagents • wait footer-smoke-test worker-b 10s");
  assert.equal(line("wait", {}), "subagents • wait until news");
  assert.equal(line("wait", { timeoutSeconds: 30 }), "subagents • wait 30s");
  assert.equal(line("connect", { a: "subagent-1", b: "subagent-2", limit: 5 }), "subagents • footer-smoke-test • connect worker-b (limit 5)");
  assert.equal(line("peers", {}), "subagents • peers");
  assert.equal(line("respond", { id: "subagent-1", requestId: "ui-1", confirmed: true }), "subagents • footer-smoke-test • respond confirmed");
  assert.equal(line("workflow-start", { path: "skills/workflows/examples/repair.json" }), "subagents • workflow start skills/workflows/examples/repair.json");
  assert.equal(line("workflow-inspect", {}), "subagents • workflows");
  assert.equal(line("workflow-inspect", { id: "workflow-1", step: "build" }), "subagents • autonomous repair • inspect build");
  assert.equal(line("workflow-control", { id: "workflow-1", action: "resume", retry: ["build", "test"] }), "subagents • autonomous repair • resume build test");
  assert.equal(line("read", { id: "missing" }), "subagents • missing • read");
});

test("call-header separators use the same glyph, color and font weight", () => {
  const styledTheme = {
    fg: (color: string, text: string) => color === "toolTitle" ? `\x1b[36m${text}\x1b[39m` : text,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as Theme;
  for (const [action, args, expected] of [
    ["read", { id: "child-1" }, "subagents • final-packaging-review • read"],
    ["workflow-inspect", { id: "workflow-1" }, "subagents • final-packaging-review • inspect"],
    ["catalog", {}, "subagents • catalog"],
  ] as const) {
    const line = subagentRenderers(action, () => "final-packaging-review")
      .renderCall(args, styledTheme, context()).render(160)[0];
    assert.equal(stripVTControlCharacters(line), expected);
    const titleSpans = [...line.matchAll(/\x1b\[36m\x1b\[1m([^\x1b]*)\x1b\[22m\x1b\[39m/g)]
      .map(match => match[1]).join("");
    assert.equal(titleSpans.split("•").length, expected.split("•").length,
      `${action}: every header separator must have the same bold toolTitle style`);
  }
});

test("chrome and display names are lowercase without altering payloads, identifiers or task case", () => {
  const data = { ...child, name: "AX Helpers", task: "Check README.md and MyAPI", id: "Agent-ABC" };
  const call = subagentRenderers("spawn").renderCall(data, theme, context()).render(160).join("\n");
  assert.match(call, /subagents • ax helpers • spawn Check README.md and MyAPI/);
  assert.match(render("spawn", data), /· ax helpers stopped/);
  assert.match(render("spawn", data, true), /"id": "Agent-ABC"/);
  assert.match(render("spawn", data, false, 120, { task: data.task }), /task: Check README.md and MyAPI/);
  assert.match(render("spawn", data, true), /"name": "AX Helpers"/);
  const unknown = subagentRenderers("read").renderCall({ id: "Agent-ABC" }, theme, context()).render(100).join("\n");
  assert.match(unknown, /Agent-ABC/);
  assert.doesNotMatch(render("read", child), /✓ idle/);
  assert.match(render("read", { ...child, hold: { kind: "halt" } }), /= footer-smoke-test held/);
  assert.match(render("read", { ...child, hold: { kind: "halt" } }), /↳ halt · 1 turn/);
});

test("overlap warning owner names are lowercase while paths and expanded payloads retain case", () => {
  const data = { ...child, coordinationWarnings: [{ id: "Agent-ABC", name: "Halt Smoke", path: "/Project/OutputCase.md" }] };
  const before = JSON.stringify(data);
  const text = render("spawn", data);
  assert.match(text, /work-area overlap: \/Project\/OutputCase.md · halt smoke/);
  assert.doesNotMatch(text, /Halt Smoke/);
  assert.match(render("spawn", data, true), /"name": "Halt Smoke"/);
  assert.equal(JSON.stringify(data), before);
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
  assert.match(collapsed, /subagents • footer-smoke-test • spawn/);
  assert.doesNotMatch(collapsed, /sessionFile/);
  tool.setExpanded(true);
  const expanded = tool.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(expanded, /full result/);
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
