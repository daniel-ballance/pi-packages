import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pistack from "../extensions/p3stack/index.ts";
import { installFooterPrefix, prefixFooter } from "../extensions/p3stack/src/footer.ts";
import { candidates, DEFAULT_ROLES, thinkingFor } from "../extensions/p3stack/src/roles.ts";

const model = (provider: string, id: string, levels: Record<string, string | null> | undefined, reasoning = true) =>
  ({ provider, id, reasoning, thinkingLevelMap: levels });
const opus = model("claude-subscription", "claude-opus-5-5", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
const grok = model("xai", "grok-4.7", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null });

// subagents: absent, loaded but too old to reply on the bus, or replying with this catalog.
type Subagents = undefined | "old" | { spawnEnabled: boolean; models: string[] };
function harness({ mode = undefined as string | undefined, hasUI = true, answers = [] as (string | undefined)[], files = {} as Record<string, unknown>, trusted = false, branch = [] as unknown[], subagents = undefined as Subagents } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pistack-ext-")), cwd = join(root, "project"), agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true }); mkdirSync(agentDir);
  for (const [path, data] of Object.entries(files)) writeFileSync(join(root, path), JSON.stringify(data));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const tools = new Map<string, any>(), commands = new Map<string, any>(), handlers = new Map<string, Function[]>();
  const entries: unknown[] = [], notices: [string, string?][] = [], statuses: [string, string | undefined][] = [], asked: string[] = [];
  const ui = {
    select: async (title: string, options: string[]) => { asked.push(`${title} [${options.join(" | ")}]`); return answers.shift(); },
    input: async (title: string) => { asked.push(title); return answers.shift(); },
    confirm: async (title: string) => { asked.push(title); return answers.shift() === "yes"; },
    notify: (message: string, type?: string) => notices.push([message, type]),
    setStatus: (key: string, text?: string) => statuses.push([key, text]),
  };
  const ctx = {
    cwd, hasUI, mode, isProjectTrusted: () => trusted,
    get ui() { if (!hasUI) throw new Error("touched ui without UI"); return ui; },
    modelRegistry: { getAvailable: () => [opus, grok] },
    sessionManager: { getBranch: () => branch },
  };
  pistack({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    getAllTools: () => [...tools.values(), ...subagents ? [{ name: "subagent_catalog" }] : []],
    events: { emit: (channel: string, data: { reply(value: unknown): void }) => { if (channel === "subagents:catalog" && subagents && subagents !== "old") data.reply(subagents); } },
  } as never);
  const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); return event; };
  // What before_agent_start handlers return as messages beside the request.
  const reminders = async (event: any) => { const out = []; for (const handler of handlers.get("before_agent_start") ?? []) { const result = await handler(event, ctx); if (result?.message) out.push(result.message); } return out; };
  const call = (name: string, args: unknown) => tools.get(name).execute("call", args, undefined, undefined, ctx);
  const command = (name: string, args = "") => commands.get(name).handler(args, ctx);
  const dispose = () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); };
  return { root, cwd, agentDir, tools, commands, emit, reminders, call, command, entries, notices, statuses, asked, dispose };
}
const text = (result: { content: { text: string }[] }) => result.content.map(part => part.text).join("\n");

test("a budget sets each model's thinking level, clamped to what that model offers", () => {
  assert.equal(thinkingFor("unlimited", opus), "max");
  assert.equal(thinkingFor("unlimited", grok), "xhigh", "Grok tops out at xhigh");
  assert.equal(thinkingFor("small", grok), "medium");
  assert.equal(thinkingFor("large", model("p", "plain", undefined, false)), "off", "a model without reasoning stays off");
  const highOnly = model("p", "deep", { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
  assert.equal(thinkingFor("small", highOnly), undefined, "never above the budget");
  assert.deepEqual(candidates("small", [opus, highOnly]), ["claude-subscription/claude-opus-5-5:medium"]);
});

test("with a subagents catalog, only its identities are offered, at the highest level within the budget", () => {
  const catalog = ["xai/grok-4.7:high", "xai/grok-4.7:low", "p/deep:xhigh", "malformed"];
  assert.deepEqual(candidates("medium", [opus, grok], catalog), ["xai/grok-4.7:high"]);
  assert.deepEqual(candidates("unlimited", [], catalog), ["xai/grok-4.7:high", "p/deep:xhigh"]);
});

test("pistack_roles answers with the role table as text, from the file or the default hints", async () => {
  const h = harness({ files: { "agent/pistack.json": { budget: "large (xhigh)", roles: { "swarm workers": "xai/grok-4.7:xhigh" } } } });
  try {
    const result = await h.call("pistack_roles", {});
    assert.match(text(result), /^Role defaults from .*agent\/pistack\.json \(budget large \(xhigh\)\)/);
    assert.match(text(result), /swarm workers: xai\/grok-4\.7:xhigh\n/);
    assert.match(text(result), /judgment and prose: claude-opus-5-5-xhigh \(default hint\)/);
    assert.equal(result.structuredContent.roles["swarm workers"], "xai/grok-4.7:xhigh");
    assert.equal(Object.keys(result.structuredContent.roles).length, Object.keys(DEFAULT_ROLES).length);
  } finally { h.dispose(); }
});

test("a trusted project's file wins over the personal one, and a broken file is reported, not used", async () => {
  const project = harness({ trusted: true, files: { "project/.pi/pistack.json": { roles: { "bug-fix": "a/b:low" } }, "agent/pistack.json": { roles: { "bug-fix": "c/d:high" } } } });
  try { assert.match(text(await project.call("pistack_roles", {})), /bug-fix: a\/b:low/); } finally { project.dispose(); }
  const untrusted = harness({ trusted: false, files: { "project/.pi/pistack.json": { roles: { "bug-fix": "a/b:low" } } } });
  try { assert.match(text(await untrusted.call("pistack_roles", {})), /bug-fix: grok-4\.7-xhigh-fast \(default hint\)/); } finally { untrusted.dispose(); }
  const broken = harness({ files: { "agent/pistack.json": { roles: { "bug-fix": 7 } } } });
  try {
    const result = await broken.call("pistack_roles", {});
    assert.match(text(result), /ignored .*pistack\.json: role "bug-fix" must be a model or a list of models/);
    assert.match(text(result), /bug-fix: grok-4\.7-xhigh-fast \(default hint\)/);
  } finally { broken.dispose(); }
});

test("the mode toggle persists, adds a prompt section while on, and shows only in the terminal", async () => {
  const h = harness();
  try {
    await h.command("pistack-mode", "on");
    assert.deepEqual(h.entries.at(-1), { customType: "pistack-mode", data: { on: true } });
    assert.deepEqual(h.statuses, [], "T3 shows no status, so none is set outside the terminal");
    const event = await h.emit("before_agent_start", { messageType: "user", systemPromptOptions: { sections: {} } });
    const section = event.systemPromptOptions.sections["pistack-mode"];
    assert.match(section, /poteto-mode is on.*skills\/poteto-mode\/SKILL\.md/s);
    assert.match(section, /Role models \(no role defaults file.*\n- bug-fix: grok-4\.7-xhigh-fast/s, "the role table rides along");
    const reminders = await h.reminders({ messageType: "user", systemPromptOptions: { sections: {} } });
    assert.equal(reminders.length, 1, "each user turn gets a reminder beside the request");
    assert.equal(reminders[0].display, false);
    assert.match(reminders[0].content, /^\[poteto-mode is on\] Before anything else, route this request: read .*poteto-mode\/SKILL\.md/);
    assert.deepEqual(await h.reminders({ messageType: "custom", systemPromptOptions: { sections: {} } }), [], "not for runs a custom message started");
    await h.command("pistack-mode", "off");
    const off = await h.emit("before_agent_start", { systemPromptOptions: { sections: { "pistack-mode": "stale" } } });
    assert.equal(off.systemPromptOptions.sections["pistack-mode"], undefined);
    assert.deepEqual(await h.reminders({ messageType: "user", systemPromptOptions: { sections: {} } }), [], "no reminder while off");
  } finally { h.dispose(); }
  // Pi's footer only loads inside Pi; here the terminal falls back to a status row.
  const tui = harness({ mode: "tui" });
  try {
    await tui.emit("session_start");
    await tui.command("pistack-mode", "on");
    assert.deepEqual(tui.statuses.at(-1), ["pistack", "poteto-mode"]);
    await tui.command("pistack-mode", "off");
    assert.deepEqual(tui.statuses.at(-1), ["pistack", undefined]);
  } finally { tui.dispose(); }
  const resumed = harness({ hasUI: false, branch: [{ type: "custom", customType: "pistack-mode", data: { on: true } }] });
  try {
    await resumed.emit("session_start");
    const event = await resumed.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
    assert.ok(event.systemPromptOptions.sections["pistack-mode"], "rebuilt from the branch");
  } finally { resumed.dispose(); }
});

// Pi-tui's width rules for these cases: the potato and the ellipsis glyphs are 2 and 1 wide.
const measure = {
  visibleWidth: (line: string) => [...line.replace(/\x1b\[[0-9;]*m/g, "")].reduce((width, char) => width + (char === "🥔" ? 2 : 1), 0),
  truncateToWidth: (line: string, width: number, ellipsis = "") => { let out = ""; for (const char of line) { if (measure.visibleWidth(out + char + ellipsis) > width) break; out += char; } return out + ellipsis; },
};

test("the potato goes before the working directory without widening the footer", () => {
  assert.deepEqual(prefixFooter(["~/code (main)", "stats", "statuses"], 40, "🥔 ", measure), ["🥔 ~/code (main)", "stats", "statuses"]);
  assert.deepEqual(prefixFooter(["~/code", "stats"], 40, "", measure), ["~/code", "stats"], "no potato while the mode is off");
  const labelled = "~/code" + " ".repeat(10) + "subagents: 1/2"; // 30 wide, as subagents right-aligns it
  assert.equal(prefixFooter([labelled, "stats"], 30, "🥔 ", measure)[0], "🥔 ~/code" + " ".repeat(7) + "subagents: 1/2", "a right-aligned label keeps its place");
  assert.equal(prefixFooter(["~/a/very/long/project/path", "stats"], 20, "🥔 ", measure)[0], "🥔 ~/a/very/long/...");
});

test("the footer hook decorates Pi's renderer until it is removed, and leaves later wrappers alone", () => {
  class Footer { render(width: number) { return [`~/code ${width}`, "stats"]; } }
  let on = true;
  const remove = installFooterPrefix(Footer.prototype, () => on ? "🥔 " : "", measure);
  assert.deepEqual(new Footer().render(40), ["🥔 ~/code 40", "stats"]);
  on = false;
  assert.deepEqual(new Footer().render(40), ["~/code 40", "stats"]);
  on = true;
  remove();
  assert.deepEqual(new Footer().render(40), ["~/code 40", "stats"], "removed");
  const removeAgain = installFooterPrefix(Footer.prototype, () => { throw new Error("broken"); }, measure);
  assert.deepEqual(new Footer().render(40), ["~/code 40", "stats"], "a failing decoration keeps the stock footer");
  const later = Footer.prototype.render = function (this: Footer, width: number) { return [`later ${width}`]; };
  removeAgain();
  assert.equal(Footer.prototype.render, later, "another extension's later wrapper is not overwritten");
});

test("while the mode is on, delegated briefs start with the poteto-agent recipe, once", async () => {
  const h = harness();
  try {
    const spawn: any = { toolName: "subagent_spawn", input: { task: "Fix the bug." } };
    await h.emit("tool_call", spawn);
    assert.equal(spawn.input.task, "Fix the bug.", "mode off: untouched");
    await h.command("pistack-mode", "on");
    await h.emit("tool_call", spawn);
    assert.match(spawn.input.task, /^Before any work, read .*agents\/poteto-agent\.md.*\n\nFix the bug\.$/s);
    const again = spawn.input.task;
    await h.emit("tool_call", spawn);
    assert.equal(spawn.input.task, again, "not prefixed twice");
    const t3: any = { toolName: "mcp__t3-code__delegate_task", input: { task: "Review it." } };
    await h.emit("tool_call", t3);
    assert.match(t3.input.task, /poteto-agent\.md/);
  } finally { h.dispose(); }
});

test("a Child with neither edit, write nor subagent_spawn gets the short read-only recipe instead of the full skill", async () => {
  const h = harness();
  try {
    await h.command("pistack-mode", "on");
    const reader: any = { toolName: "subagent_spawn", input: { task: "Audit stats.ts.", tools: ["read", "bash", "grep"] } };
    await h.emit("tool_call", reader);
    assert.match(reader.input.task, /^You are a read-only delegate in a poteto-mode run\. .*do not read the poteto-mode skill.*\n\nAudit stats\.ts\.$/s);
    assert.doesNotMatch(reader.input.task, /poteto-agent\.md/);
    const again = reader.input.task;
    await h.emit("tool_call", reader);
    assert.equal(reader.input.task, again, "not prefixed twice");
    const writer: any = { toolName: "subagent_spawn", input: { task: "Fix it.", tools: ["read", "edit"] } };
    await h.emit("tool_call", writer);
    assert.match(writer.input.task, /^Before any work, read .*poteto-agent\.md/s, "an editing Child keeps the full recipe");
    const coordinator: any = { toolName: "subagent_spawn", input: { task: "Coordinate the audit.", tools: ["read", "subagent_spawn", "subagent_wait"] } };
    await h.emit("tool_call", coordinator);
    assert.match(coordinator.input.task, /poteto-agent\.md/, "a coordinator delegates, so it keeps the full recipe");
    const t3: any = { toolName: "mcp__t3-code__delegate_task", input: { task: "Audit it.", tools: ["read"] } };
    await h.emit("tool_call", t3);
    assert.match(t3.input.task, /poteto-agent\.md/, "T3 tasks have no tool list, so they keep the full recipe");
  } finally { h.dispose(); }
});

test("ask_user asks through the UI, and without one says to apply the stated default", async () => {
  const h = harness({ answers: ["beta", "Other (type an answer)", "gamma", undefined] });
  try {
    assert.equal(h.tools.get("ask_user").exposure, "model-only");
    assert.match(text(await h.call("ask_user", { question: "Which?", options: ["alpha", "beta"] })), /The human chose: beta/);
    assert.match(text(await h.call("ask_user", { question: "Which?", options: ["alpha"], allowOther: true })), /The human answered: gamma/);
    assert.match(text(await h.call("ask_user", { question: "Name?", default: "x" })), /dismissed.*apply your default \(x\)/is);
  } finally { h.dispose(); }
  const headless = harness({ hasUI: false });
  try {
    assert.match(text(await headless.call("ask_user", { question: "Which?", options: ["a"], default: "a" })), /No one can be asked.*apply your default \(a\) and say so/is);
  } finally { headless.dispose(); }
});

// The suite also runs with a fake T3_MCP_URL; tests of terminal behaviour pin the host.
function asTerminal() {
  const previous = process.env.T3_MCP_URL;
  delete process.env.T3_MCP_URL;
  return () => { if (previous !== undefined) process.env.T3_MCP_URL = previous; };
}

test("/pistack-setup maps a budget and two models onto every role and writes the file", async () => {
  const restore = asTerminal();
  const h = harness({ answers: ["unlimited — max thinking", "xai/grok-4.7:xhigh", "claude-subscription/claude-opus-5-5:max"] });
  try {
    await h.command("pistack-setup");
    const written = JSON.parse(readFileSync(join(h.agentDir, "pistack.json"), "utf8"));
    assert.equal(written.budget, "unlimited (max)");
    assert.equal(written.roles["swarm workers"], "xai/grok-4.7:xhigh");
    assert.equal(written.roles["judgment and prose"], "claude-subscription/claude-opus-5-5:max");
    assert.deepEqual(written.roles["interrogate reviewers"], ["claude-subscription/claude-opus-5-5:max", "xai/grok-4.7:xhigh"]);
    assert.match(h.notices.at(-1)![0], /Wrote .*pistack\.json/);
  } finally { h.dispose(); restore(); }
});

test("/pistack-setup defers to the skill under T3 and does nothing without a UI", async () => {
  const previous = process.env.T3_MCP_URL;
  process.env.T3_MCP_URL = "http://127.0.0.1:1/mcp";
  const h = harness();
  try {
    await h.command("pistack-setup");
    assert.match(h.notices.at(-1)![0], /\/skill:setup-pstack/);
    assert.deepEqual(h.asked, []);
  } finally { h.dispose(); if (previous === undefined) delete process.env.T3_MCP_URL; else process.env.T3_MCP_URL = previous; }
  const headless = harness({ hasUI: false });
  try { await headless.command("pistack-setup"); } finally { headless.dispose(); }
});

test("/pistack-setup offers only models the subagents policy permits, and never writes one it cannot check", async () => {
  const restore = asTerminal();
  // Harnesses own PI_CODING_AGENT_DIR, so one at a time.
  const run = async (subagents: Subagents, answers: string[], check: (h: ReturnType<typeof harness>, written: unknown) => void) => {
    const h = harness({ subagents, answers });
    try {
      await h.command("pistack-setup");
      let written: unknown;
      try { written = JSON.parse(readFileSync(join(h.agentDir, "pistack.json"), "utf8")); } catch { written = undefined; }
      check(h, written);
    } finally { h.dispose(); }
  };
  try {
    await run({ spawnEnabled: true, models: ["xai/grok-4.7:high", "xai/grok-4.7:xhigh"] }, ["large — xhigh thinking", "xai/grok-4.7:xhigh", "xai/grok-4.7:xhigh"], (h, written) => {
      assert.match(h.asked[1]!, /\[xai\/grok-4\.7:xhigh\]$/, "Opus is authenticated but not permitted");
      assert.equal((written as { roles: Record<string, string> }).roles["bug-fix"], "xai/grok-4.7:xhigh");
    });
    await run("old", [], (h, written) => { assert.match(h.notices.at(-1)![0], /\/skill:setup-pstack/); assert.equal(written, undefined); });
    await run({ spawnEnabled: false, models: [] }, [], (h, written) => { assert.match(h.notices.at(-1)![0], /does not permit spawning/); assert.equal(written, undefined); });
    await run({ spawnEnabled: true, models: ["xai/grok-4.7:xhigh"] }, ["small — medium thinking"], (h, written) => {
      assert.match(h.notices.at(-1)![0], /No permitted model offers thinking at or below medium/);
      assert.equal(written, undefined);
    });
  } finally { restore(); }
});
