import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { ActivityFeed } from "../extensions/subagents/src/activity.js";
import { InspectorPanel } from "../extensions/subagents/src/inspector.js";
import { cleanText, inspectorPage, inspectorSource, type InspectorSource } from "../extensions/subagents/src/inspector-data.js";
import { workflowMap } from "../extensions/subagents/src/workflow-map.js";
import { SubagentManager } from "../extensions/subagents/src/manager.js";
import { Workflows } from "../extensions/subagents/src/workflows.js";
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
  assert.deepEqual(page.rows.filter(r => r.target).map(r => r.id), ["workflow:workflow-approval", "workflow:workflow-demo", "agent:cache", "history"]);
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
  assert.match(p.render(), /subagents/);
  p.press("\x1b[B"); // attention approval -> working workflow
  assert.match(p.press("\r"), /workflow ↓/);
  p.press("\x1b[B"); // gather -> security
  assert.match(p.press("\r"), /attempts/);
  assert.match(p.press("\r"), /workers/);
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
  p.render(); p.press("\x1b[B"); p.press("\r");
  p.press("\x1b[B"); p.press("\x1b[B"); // compatibility
  const wide = p.render(120);
  assert.match(wide, /├─▶╮/);
  assert.match(wide, /› │\s+✓\s+compatibility/);
  const narrow = p.render(45);
  assert.match(narrow, /prerequisites/);
  assert.match(narrow, /› ✓ compatibility/);
  assert.match(narrow, /← security \+ compatibility/);
  assert.match(p.render(120), /› │\s+✓\s+compatibility/);
  assert.match(p.press("\r"), /documentation refresh \/ compatibility/);
});

test("workflow status updates change labels, not topology or selection; all widths fit", () => {
  const source = demoSource(), run = source.workflows()[0], p = panel(source);
  const before = inspectorPage(source, { kind: "workflow", id: run.id });
  p.render(); p.press("\x1b[B"); p.press("\r"); p.press("\x1b[B");
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
  assert.match(p.render(), /› ● renamed caching task/);
  assert.match(p.press("\r"), /renamed caching task/);
});

test("agent auto-follow pauses while scrolling, anchors through updates, and End resumes", () => {
  const source = demoSource(), p = panel(source, 18);
  p.render(); p.press("\x1b[B"); p.press("\x1b[B"); p.press("\r");
  assert.match(p.render(), /purpose: Investigate/);
  assert.match(p.press("\x1b[F"), /following/);
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
  assert.match(text, /input requested: Approve action/);
  assert.match(text, /purpose: Investigate/);
  assert.match(text, /latest result/);
  const details = inspectorPage(source, { kind: "agent-details", id: agent.id }).rows.map(r => r.text).join("\n");
  assert.match(details, /saved session:/);
  assert.match(details, /event log:/);
});

test("unreviewed idle results, holds and assignments remain prominent; peer audit is observational", () => {
  const source = demoSource(), idle = source.agents().find(a => a.id === "history")!;
  idle.readCursor = 0;
  Object.assign(idle, { assignment: { id: "run-1", task: "Review dependencies", status: "completed" }, resultReview: { assignmentId: "run-1", status: "unreviewed" }, hold: { kind: "halt", at: "2025-01-01T00:00:00Z", outcome: "confirmed" } });
  assert.ok(inspectorPage(source, { kind: "overview" }).rows.some(r => r.id === `agent:${idle.id}`));
  assert.ok(!inspectorPage(source, { kind: "overview", history: true }).rows.some(r => r.id === `agent:${idle.id}`));
  const rows = inspectorPage(source, { kind: "agent", id: idle.id }).rows;
  assert.deepEqual(rows.slice(0, 5).map(r => r.id), ["hold", "purpose", "current", "result", "assignment"]);
  assert.match(rows.map(r => r.text).join("\n"), /parent review unreviewed/);
  assert.ok(!rows.some(r => r.text.includes("✓ idle")));
  let inspections = 0;
  source.peers = id => { inspections++; assert.equal(id, idle.id); return { policyCeiling: 3, links: [{ a: "history", b: "security", enabled: true,
    ab: { limit: 3, used: 1, total: 1, generation: 1 }, ba: { limit: 3, used: 2, total: 2, generation: 1 } }],
    messages: [{ id: "msg", cursor: 1, sender: "history", recipient: "security", senderName: "Review", recipientName: "Security",
      message: "Need evidence", generation: 1, time: "2025-01-01", status: "unknown" }], nextCursor: 1, hasMore: false, gap: false, retained: 1, cursor: 1 }; };
  const audit = inspectorPage(source, { kind: "agent-peers", id: idle.id }).rows.map(r => r.text).join("\n");
  assert.match(audit, /1\/3 remaining/);
  assert.match(audit, /unknown/);
  assert.equal(inspections, 1);
  assert.equal(idle.readCursor, 0);
  idle.config.coordination = { owns: ["src/cache.ts"], outputs: ["cache-report.md"] };
  assert.match(inspectorPage(source, { kind: "agent-details", id: idle.id }).rows.map(r => r.text).join("\n"), /owns: src\/cache.ts[\s\S]*outputs: cache-report.md/);
});

test("worker summary bounds long purpose/result, holds first, and stops elapsed at assignment finish", () => {
  const source = demoSource(), agent = source.agents()[0];
  const task = "TaskCase ".repeat(500), result = "ResultCase ".repeat(500);
  agent.task = task;
  agent.assignment = { id: "assignment-1", task, status: "completed", at: "2025-01-01T00:00:00Z", finishedAt: "2025-01-01T00:00:30Z", resultCursor: 6 };
  agent.resultReview = { assignmentId: "assignment-1", status: "reviewed" };
  agent.hold = { kind: "halt", at: "2025-01-01T00:00:25Z", outcome: "failed", detail: "timed out" };
  agent.updatedAt = "2025-01-01T00:00:35Z";
  agent.updates[5].text = result;
  const now = Date.parse("2025-01-01T00:02:35Z");
  const rows = inspectorPage(source, { kind: "agent", id: agent.id }, now).rows;
  assert.deepEqual(rows.slice(0, 5).map(r => r.id), ["hold", "purpose", "current", "result", "assignment"]);
  assert.ok(rows.find(r => r.id === "purpose")!.text.length < 450);
  assert.ok(rows.find(r => r.id === "result")!.text.length < 650);
  assert.match(rows.find(r => r.id === "current")!.text, /elapsed 30s · last observed 2m 0s ago/);
  assert.match(rows.find(r => r.id === "assignment")!.text, /parent review reviewed/);
  delete agent.assignment.finishedAt;
  assert.match(inspectorPage(source, { kind: "agent", id: agent.id }, now).rows.find(r => r.id === "current")!.text, /elapsed 35s \(last observed\)/);
  assert.doesNotMatch(rows.find(r => r.id === "assignment")!.text, /needed/);
  const detail = inspectorPage(source, { kind: "agent-details", id: agent.id }).rows;
  assert.equal(detail.find(r => r.id === "task-full")!.text, `task: ${task}`);
  assert.ok(rows.some(r => r.id === "update:6" && r.text.includes(result)));
  const p = panel(source, 18);
  p.render(); p.press("\x1b[B");
  assert.match(p.press("\r"), /halt failed/); // The hold remains visible even in the short viewport.
});

test("held workflows stay in attention, including pausing and terminal runs with a held worker", () => {
  const source = demoSource(), run = source.workflows()[0];
  run.status = "succeeded"; run.unread = false;
  const worker = source.agents().find(a => a.id === "security")!;
  worker.hold = { kind: "kill", at: "2025-01-01T00:00:00Z", outcome: "pending" };
  let page = inspectorPage(source, { kind: "overview" });
  assert.ok(page.rows.some(r => r.id === `workflow:${run.id}` && r.text.includes("intervention hold")));
  assert.ok(!inspectorPage(source, { kind: "overview", history: true }).rows.some(r => r.id === `workflow:${run.id}`));
  delete worker.hold;
  run.interventionHold = { at: "2025-01-01T00:00:00Z", reason: "review needed" };
  page = inspectorPage(source, { kind: "overview" });
  assert.ok(page.rows.some(r => r.id === `workflow:${run.id}`));
  assert.match(inspectorPage(source, { kind: "workflow", id: run.id }).rows[0].text, /intervention hold at .*review needed/);
  delete run.interventionHold;
  run.status = "pausing";
  assert.equal(inspectorPage(source, { kind: "overview" }).rows[0].id, "attention");
});

test("peer audit defaults to recent exchanges and paginates retained history without acknowledging", () => {
  const source = demoSource(), agent = source.agents()[0];
  const requested: (number | undefined)[] = [];
  source.peers = (_id, since) => {
    requested.push(since);
    return { policyCeiling: 4, links: [], messages: [{ id: `m${since ?? "recent"}`, cursor: (since ?? 5) + 1,
      sender: "cache", recipient: "security", senderName: "Cache", recipientName: "Security", message: "result", generation: 1,
      time: "2025-01-01", status: "interrupted" }], nextCursor: (since ?? 5) + 1, hasMore: since === 0,
      gap: false, retained: 10, cursor: 10 };
  };
  const recent = inspectorPage(source, { kind: "agent-peers", id: agent.id });
  assert.match(recent.subtitle, /recent retained/);
  assert.match(recent.rows.map(r => r.text).join("\n"), /interrupted/);
  const browse = recent.rows.find(r => r.id === "peer-history")!.target!;
  const first = inspectorPage(source, browse);
  assert.match(first.subtitle, /oldest first/);
  assert.ok(first.rows.find(r => r.id.startsWith("peer-next:"))?.target);
  assert.deepEqual(requested, [undefined, 0]);
  assert.equal(agent.readCursor, 0);
});

test("Halt acts only on explicit worker; Kill requires target confirmation; Esc never kills", async () => {
  const source = demoSource(), calls: string[] = [];
  const p = new InspectorPanel(source, theme, keys, () => 24, () => {}, () => {}, {
    halt: async id => { calls.push(`halt:${id}`); return { ok: false, message: "already stopped" }; },
    kill: async id => { calls.push(`kill:${id}`); throw new Error("transport failed"); },
  });
  const render = () => plain(p.render(100));
  render(); p.handleInput("h"); p.handleInput("K"); p.handleInput("\r");
  assert.deepEqual(calls, []);
  p.handleInput("\x1b[B"); p.handleInput("\x1b[B"); p.handleInput("\x1b[B"); p.handleInput("\r");
  render(); p.handleInput("K");
  const warning = render();
  assert.match(warning, /target: cache · investigate caching/);
  assert.match(warning, /force-stop the worker process/);
  assert.match(warning, /edits are not rolled back/);
  assert.match(warning, /detached subprocesses may survive/);
  p.handleInput("\x1b"); assert.deepEqual(calls, []);
  p.handleInput("h"); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["halt:cache"]); assert.match(render(), /halt failed for cache: already stopped/);
  p.handleInput("K"); render(); p.handleInput("\r"); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["halt:cache", "kill:cache"]); assert.match(render(), /kill failed for cache: Error: transport failed/);
});

test("kill confirmation respects remapped select keys and doesn't accept Enter when rebound", async () => {
  const source = demoSource(); let killed = 0;
  const remapped = { ...keys,
    matches: (data: string, action: string) => action === "tui.select.confirm" ? data === "x" : action === "tui.select.cancel" ? data === "q" : keys.matches(data, action as Parameters<typeof keys.matches>[1]),
    getKeys: (action: string) => action === "tui.select.confirm" ? ["x"] : action === "tui.select.cancel" ? ["q"] : keys.getKeys(action as Parameters<typeof keys.getKeys>[0]),
  } as Pick<KeybindingsManager, "matches" | "getKeys">;
  const p = new InspectorPanel(source, theme, remapped, () => 24, () => {}, () => {}, { kill: async () => { killed++; return { ok: true, message: "done" }; } });
  p.render(100); p.handleInput("\x1b[B"); p.handleInput("\x1b[B"); p.handleInput("x"); p.render(100);
  p.handleInput("K"); assert.match(plain(p.render(100)), /x confirms this target/);
  p.handleInput("\r"); assert.equal(killed, 0);
  p.handleInput("K"); p.handleInput("q"); assert.equal(killed, 0);
  p.handleInput("K");
  assert.match(plain(p.render(40)), /resize to read/);
  p.handleInput("x"); assert.equal(killed, 0); // Narrow viewport cannot hide the danger and still confirm.
  assert.match(plain(p.render(100)), /detached subprocesses may survive/);
  p.handleInput("x"); assert.equal(killed, 1);
});

test("pending halt never blocks confirmed kill escalation on the same held worker", async () => {
  const source = demoSource(), calls: string[] = [];
  let releaseHalt!: (result: { ok: boolean; message: string }) => void;
  const halt = new Promise<{ ok: boolean; message: string }>(resolve => { releaseHalt = resolve; });
  const p = new InspectorPanel(source, theme, keys, () => 24, () => {}, () => {}, {
    halt: async id => { calls.push(`halt:${id}`); return halt; },
    kill: async id => { calls.push(`kill:${id}`); return { ok: true, message: "terminated" }; },
  });
  p.render(100);
  for (let i = 0; i < 2; i++) p.handleInput("\x1b[B");
  p.handleInput("\r"); p.render(100);
  p.handleInput("h");
  assert.deepEqual(calls, ["halt:cache"]);
  Object.assign(source.agents().find(a => a.id === "cache")!, { hold: { kind: "halt", at: new Date().toISOString(), outcome: "pending" } });
  p.handleInput("K");
  assert.match(plain(p.render(100)), /target: cache · investigate caching/);
  p.handleInput("\r"); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["halt:cache", "kill:cache"]);
  releaseHalt({ ok: false, message: "no response" }); await new Promise(resolve => setImmediate(resolve));
  assert.match(plain(p.render(100)), /halt failed.*kill result/);
});

test("action feedback and pending operations stay scoped to the selected worker", async () => {
  const template = demoSource().agents()[0];
  const agents = ["alpha", "beta"].map(id => ({ ...structuredClone(template), id, name: id }));
  const source: InspectorSource = { agents: () => agents, workflows: () => [], activity: () => ({ tools: [], text: "" }) };
  const calls: string[] = [];
  const finish = new Map<string, (result: { ok: boolean; message: string }) => void>();
  const p = new InspectorPanel(source, theme, keys, () => 24, () => {}, () => {}, {
    halt: id => { calls.push(id); return new Promise(resolve => finish.set(id, resolve)); },
    kill: async () => ({ ok: true, message: "killed" }),
  });
  const render = () => plain(p.render(180));
  const press = (key: string) => { p.handleInput(key); return render(); };
  render(); press("\r"); press("h");
  assert.match(render(), /halt requested for alpha/);
  assert.doesNotMatch(press("\x1b"), /halt requested for alpha/);
  press("\x1b[B"); press("\r");
  assert.doesNotMatch(render(), /halt requested for alpha/);
  press("h");
  assert.deepEqual(calls, ["alpha", "beta"], "one worker's pending halt must not block another's");
  finish.get("alpha")!({ ok: true, message: "ALPHA_RESULT" });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(render(), /ALPHA_RESULT|for alpha/);
  assert.match(render(), /halt requested for beta/);
  finish.get("beta")!({ ok: true, message: "BETA_RESULT" });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(render(), /halt result for beta: BETA_RESULT/);
  press("K"); render();
  assert.doesNotMatch(render(), /ALPHA_RESULT/);
  press("\x1b"); // Cancel beta's kill confirmation, without navigating.
  assert.match(render(), /kill cancelled/);
  press("\x1b"); press("\x1b[A"); press("\r");
  assert.match(render(), /halt result for alpha: ALPHA_RESULT/);
  assert.doesNotMatch(render(), /BETA_RESULT|kill cancelled/);
});

test("oversized saved-output placeholder uses lowercase chrome without changing report content", () => {
  const source = demoSource(), agent = source.agents()[0];
  const report = "UPPERCASE output ".repeat(1500);
  agent.updates = [{ cursor: 100, kind: "assistant", text: report, time: new Date(Date.now() + 1000).toISOString() }];
  source.activity = () => ({ tools: [], text: "" });
  const p = panel(source, 20);
  p.render(); p.press("\x1b[B"); p.press("\x1b[B"); p.press("\r");
  assert.match(p.press("\x1b[F"), /\[more in saved logs\]/);
  assert.equal(agent.updates[0].text, report);
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
  assert.match(panel(source).render(), /no current background work/);
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

test("a nested Child's row names the Child that delegated it", () => {
  const source = demoSource();
  const [coordinator] = source.agents().filter(agent => !agent.workflow);
  const nested = { ...structuredClone(coordinator!), id: "nested", name: "Nested Worker", parentId: coordinator!.id, depth: 2 };
  const agents = [...source.agents(), nested];
  const page = inspectorPage({ ...source, agents: () => agents }, { kind: "overview", history: true });
  const row = [...page.rows, ...inspectorPage({ ...source, agents: () => agents }, { kind: "overview" }).rows].find(r => r.id === "agent:nested")!;
  assert.match(row.text, new RegExp(`^\\S+ ↳ nested worker · .* · from ${coordinator!.name.toLowerCase()} · `));
});
