import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { ActivityFeed } from "../src/activity.js";
import { InspectorPanel } from "../src/inspector.js";
import { cleanText, inspectorPage, inspectorSource, type InspectorSource } from "../src/inspector-data.js";
import { workflowMap } from "../src/workflow-map.js";
import { SubagentManager } from "../src/manager.js";
import { Workflows } from "../src/workflows.js";
import { demoSource } from "./fixtures/inspector-demo.js";

const plain = (lines: string[]) => lines.map(stripVTControlCharacters).join("\n");
const keyMap: Record<string, string> = { "tui.select.up": "up", "tui.select.down": "down", "tui.select.confirm": "enter", "tui.select.cancel": "escape", "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown" };
const keys = { matches: (data: string, action: string) => matchesKey(data, keyMap[action] as "up"), getKeys: (action: string) => [keyMap[action]] } as Pick<KeybindingsManager, "matches" | "getKeys">;
const theme = { fg: (_tone: string, text: string) => `\x1b[38;5;242m${text}\x1b[39m` } as Theme;
function panel(source = demoSource(), height = 24) {
  let closed = 0;
  const component = new InspectorPanel(source, theme, keys, () => height, () => {}, () => closed++);
  const render = (width = 100) => plain(component.render(width));
  const press = (key: string) => { component.handleInput(key); return render(); };
  return { component, render, press, closed: () => closed };
}

test("overview groups owned workers once and keeps completed work in history", () => {
  const source = demoSource();
  const page = inspectorPage(source, { kind: "overview" });
  assert.deepEqual(page.rows.filter(r => r.target).map(r => r.id), ["workflow:workflow-demo", "workflow:workflow-approval", "agent:cache", "history"]);
  assert.ok(page.rows.some(r => r.text.includes("approval needed")));
  assert.ok(!page.rows.some(r => r.id === "agent:security"));
  assert.ok(inspectorPage(source, { kind: "overview", history: true }).rows.some(r => r.id === "agent:history"));
  const orphan = source.agents().find(a => a.id === "security")!;
  orphan.workflow = "missing-run";
  assert.ok(inspectorPage(source, { kind: "overview" }).rows.some(r => r.id === "agent:security"));
});

test("workflow map retains fan-in, implicit input edges, checks and loops", () => {
  const source = demoSource(), run = source.workflows()[0];
  assert.deepEqual(workflowMap([...run.definition.steps].reverse(), 80).rows.flatMap(row => row.step ? [row.step.id] : []), ["gather", "compatibility", "security", "synthesis", "approve"]);
  const text = inspectorPage(source, { kind: "workflow", id: run.id }, Date.now(), 40).rows.map(r => r.text).join("\n");
  assert.match(text, /← security \+ compatibility/);
  assert.match(text, /← synthesis/);
  assert.match(text, /repair loop 0\/3/);
  assert.match(text, /human check/);
  assert.throws(() => workflowMap([{ ...run.definition.steps[0], dependsOn: ["missing"] }], 80), /Invalid workflow/);
});

test("keyboard drilldown reaches attempts and the shared worker view; Esc restores selection", () => {
  const p = panel();
  assert.match(p.render(), /Subagents/);
  assert.match(p.press("\r"), /WORKFLOW ↓/);
  p.press("\x1b[B"); // gather -> security
  assert.match(p.press("\r"), /ATTEMPTS/);
  assert.match(p.press("\r"), /WORKERS/);
  assert.match(p.press("\r"), /synthetic demo|simulated streaming/);
  p.press("\x1b"); p.press("\x1b");
  assert.match(p.press("\x1b"), /› ●\s+│\s+security/);
  p.press("\x1b"); p.press("\x1b");
  assert.equal(p.closed(), 1);
  p.component.close();
  assert.equal(p.closed(), 1);
});

test("workflow graph switches to compact prerequisites without losing the selected step", () => {
  const p = panel();
  p.render(); p.press("\r");
  p.press("\x1b[B"); p.press("\x1b[B"); // compatibility
  const wide = p.render(120);
  assert.match(wide, /├─▶╮/);
  assert.match(wide, /› │\s+✓\s+compatibility/);
  const narrow = p.render(45);
  assert.match(narrow, /PREREQUISITES/);
  assert.match(narrow, /› ✓ compatibility/);
  assert.match(narrow, /← security \+ compatibility/);
  assert.match(p.render(120), /› │\s+✓\s+compatibility/);
  assert.match(p.press("\r"), /Documentation refresh \/ compatibility/);
});

test("workflow status updates change labels, not topology or selection; all widths fit", () => {
  const source = demoSource(), run = source.workflows()[0], p = panel(source);
  const before = inspectorPage(source, { kind: "workflow", id: run.id });
  p.render(); p.press("\r"); p.press("\x1b[B");
  run.steps.security.status = "failed";
  run.status = "blocked";
  const after = inspectorPage(source, { kind: "workflow", id: run.id });
  assert.deepEqual(before.rows.filter(r => r.target).map(r => r.id), after.rows.filter(r => r.target).map(r => r.id));
  assert.deepEqual(before.rows.filter(r => r.id.startsWith("edge:") || r.id.startsWith("after:")), after.rows.filter(r => r.id.startsWith("edge:") || r.id.startsWith("after:")));
  assert.match(p.render(), /› !\s+│\s+security · failed/);
  for (const width of [1, 2, 12, 30, 45, 58, 70, 120, 160]) {
    const lines = p.component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.length <= 24);
  }
});

test("selection survives new live entries and labels changing", () => {
  const source = demoSource(), p = panel(source);
  p.render(); p.press("\x1b[B"); p.press("\x1b[B"); // standalone
  source.agents()[0].name = "Renamed caching task";
  source.workflows()[0].status = "succeeded"; // preceding item goes into history
  assert.match(p.render(), /› ● Renamed caching task/);
  assert.match(p.press("\r"), /Renamed caching task/);
});

test("agent auto-follow pauses while scrolling, anchors through updates, and End resumes", () => {
  const source = demoSource(), p = panel(source, 18);
  p.render(); p.press("\x1b[B"); p.press("\x1b[B"); p.press("\r");
  assert.match(p.render(), /following/);
  p.press("\x1b[H"); // home
  const before = p.press("\x1b[B");
  assert.match(before, /scroll paused/);
  source.agents()[0].updates.push({ cursor: 7, kind: "assistant", time: new Date().toISOString(), text: "New report" });
  const after = p.render();
  assert.equal(before.split("\n")[3], after.split("\n")[3]);
  assert.match(p.press("\x1b[F"), /following/);
});

test("metadata, output, input requests and paths stay accessible", () => {
  const source = demoSource(), agent = source.agents()[0];
  agent.status = "waiting_input"; agent.uiRequests = [{ id: "input", method: "confirm", title: "Approve action?" }];
  const text = inspectorPage(source, { kind: "agent", id: agent.id }).rows.map(r => r.text).join("\n");
  assert.match(text, /Input requested: Approve action/);
  assert.match(text, /Saved session:/);
  assert.match(text, /Task: Investigate/);
  assert.match(text, /Event log:/);
});

test("all views fit narrow and wide terminals, resize and sanitize untrusted escape sequences", () => {
  const source = demoSource();
  source.agents()[0].name = "界\x1b[2J\x1b]52;c;payload\x07\nforged line";
  const p = panel(source);
  p.render(); p.press("\x1b[B"); p.press("\x1b[B"); p.press("\r");
  for (const width of [1, 2, 4, 12, 40, 70, 140]) {
    const lines = p.component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.length <= 24);
    assert.ok(!lines.join("\n").includes("\x1b[2J"));
    assert.ok(!lines.join("\n").includes("\x1b]52"));
  }
  assert.equal(cleanText("hello\x1b[31m red\x1b[0m\x07"), "hello red");
  assert.ok(panel(source, 3).component.render(20).length <= 3);
});

test("empty/missing records, theme changes and remapped keys remain usable", () => {
  const source: InspectorSource = { agents: () => [], workflows: () => [], activity: () => ({ tools: [], text: "" }) };
  assert.match(panel(source).render(), /No current background work/);
  assert.match(inspectorPage(source, { kind: "agent", id: "gone" }).title, /unavailable/);
  let shade = 240, closed = 0;
  const p = new InspectorPanel(source, { fg: (_tone: string, text: string) => `\x1b[38;5;${shade}m${text}\x1b[39m` } as Theme,
    { ...keys, matches: (data, action) => action === "tui.select.cancel" && data === "q", getKeys: () => ["q"] }, () => 12, () => {}, () => closed++);
  assert.ok(p.render(80).join("").includes("38;5;240"));
  shade = 241; p.invalidate();
  assert.ok(p.render(80).join("").includes("38;5;241"));
  p.handleInput("q"); assert.equal(closed, 1);
});

test("polling is owned by the open interaction and is disposed", async () => {
  let renders = 0;
  const p = new InspectorPanel(demoSource(), theme, keys, () => 20, () => renders++, () => {});
  p.start(); p.start();
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.ok(renders > 0);
  p.dispose(); const before = renders;
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(renders, before);
});

test("activity retains bounded real tool events and partial text, never hidden thinking", () => {
  const feed = new ActivityFeed();
  for (let n = 0; n < 50; n++) feed.accept({ type: "tool_execution_start", toolCallId: String(n), toolName: "read", args: { path: "README.md" } });
  feed.accept({ type: "tool_execution_end", toolCallId: "49", result: { content: [{ type: "text", text: "File contents" }] } });
  assert.equal(feed.snapshot().tools.length, 40);
  assert.equal(feed.snapshot().tools.at(-1)?.output, "File contents");
  feed.accept({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private thinking" } });
  assert.equal(feed.snapshot().phase, "Thinking");
  assert.equal(feed.snapshot().text, "");
  feed.accept({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(30000) } });
  assert.ok(feed.snapshot().text.length < 12100);
  feed.accept({ type: "message_end", message: { role: "assistant" } });
  assert.equal(feed.snapshot().text, "");
});

test("real manager streams activity; browsing preserves workflow and agent notices/read cursors", async () => {
  const root = mkdtempSync(join(tmpdir(), "inspector-test-"));
  const manager = new SubagentManager(join(root, "agents"));
  const workflows = new Workflows(join(root, "workflows"), { authorize() {}, agents: async jobs => jobs.map(() => "report"), command: async () => ({ code: 0, stdout: "" }) });
  try {
    const agent = await manager.spawn({ name: "Stream", task: "inspector-stream", cwd: root, executable: process.execPath,
      executableArgs: [fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url))] });
    const until = Date.now() + 3000;
    while (!manager.activitySnapshot(agent.id).text && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(manager.activitySnapshot(agent.id).text, "Live partial response");
    assert.equal(manager.activitySnapshot(agent.id).tools[0].output, "Documentation");
    await manager.abort(agent.id);
    const result = workflows.start({ version: 1, name: "Notice test", cwd: root, limits: { concurrency: 1, maxAttempts: 2, timeoutSeconds: 30 }, steps: [{ id: "task", kind: "task", worker: { model: "demo/local:off", tools: [] }, instructions: "report" }] }) as { id: string };
    while (workflows.get(result.id).status === "running") await new Promise(resolve => setTimeout(resolve, 10));
    const source = inspectorSource(manager, workflows);
    const notices = structuredClone(manager.pendingNotices()), workflowNotices = structuredClone(workflows.pendingNotices());
    const cursor = manager.get(agent.id).readCursor;
    assert.ok(notices.length); assert.ok(workflowNotices.length);
    for (let n = 0; n < 3; n++) {
      inspectorPage(source, { kind: "overview" });
      inspectorPage(source, { kind: "agent", id: agent.id });
      inspectorPage(source, { kind: "workflow", id: result.id });
      inspectorPage(source, { kind: "step", id: result.id, step: "task" });
      inspectorPage(source, { kind: "attempt", id: result.id, step: "task", attempt: 1 });
    }
    assert.equal(manager.get(agent.id).readCursor, cursor);
    assert.deepEqual(manager.pendingNotices(), notices);
    assert.deepEqual(workflows.pendingNotices(), workflowNotices);
    assert.equal(manager.activitySnapshot(agent.id).text, "");
  } finally { await workflows.shutdown(); await manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
