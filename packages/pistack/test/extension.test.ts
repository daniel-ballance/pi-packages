import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pistack from "../extensions/pistack/index.ts";
import { DEFAULT_ROLES, thinkingFor } from "../extensions/pistack/src/roles.ts";

const model = (provider: string, id: string, levels: Record<string, string | null> | undefined, reasoning = true) =>
  ({ provider, id, reasoning, thinkingLevelMap: levels });
const opus = model("claude-subscription", "claude-opus-5-5", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
const grok = model("xai", "grok-4.7", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null });

function harness({ hasUI = true, answers = [] as (string | undefined)[], files = {} as Record<string, unknown>, trusted = false, branch = [] as unknown[] } = {}) {
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
    cwd, hasUI, isProjectTrusted: () => trusted,
    get ui() { if (!hasUI) throw new Error("touched ui without UI"); return ui; },
    modelRegistry: { getAvailable: () => [opus, grok] },
    sessionManager: { getBranch: () => branch },
  };
  pistack({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
  } as never);
  const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); return event; };
  const call = (name: string, args: unknown) => tools.get(name).execute("call", args, undefined, undefined, ctx);
  const command = (name: string, args = "") => commands.get(name).handler(args, ctx);
  const dispose = () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); };
  return { root, cwd, agentDir, tools, commands, emit, call, command, entries, notices, statuses, asked, dispose };
}
const text = (result: { content: { text: string }[] }) => result.content.map(part => part.text).join("\n");

test("a budget sets each model's thinking level, clamped to what that model offers", () => {
  assert.equal(thinkingFor("unlimited", opus), "max");
  assert.equal(thinkingFor("unlimited", grok), "xhigh", "Grok tops out at xhigh");
  assert.equal(thinkingFor("small", grok), "medium");
  assert.equal(thinkingFor("large", model("p", "plain", undefined, false)), "off", "a model without reasoning stays off");
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

test("the mode toggle persists, adds a prompt section while on, and shows status only with a UI", async () => {
  const h = harness();
  try {
    await h.command("pistack-mode", "on");
    assert.deepEqual(h.entries.at(-1), { customType: "pistack-mode", data: { on: true } });
    assert.deepEqual(h.statuses.at(-1), ["pistack", "poteto-mode"]);
    const event = await h.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
    assert.match(event.systemPromptOptions.sections["pistack-mode"], /poteto-mode is on.*skills\/poteto-mode\/SKILL\.md/s);
    await h.command("pistack-mode", "off");
    const off = await h.emit("before_agent_start", { systemPromptOptions: { sections: { "pistack-mode": "stale" } } });
    assert.equal(off.systemPromptOptions.sections["pistack-mode"], undefined);
    assert.deepEqual(h.statuses.at(-1), ["pistack", undefined]);
  } finally { h.dispose(); }
  const resumed = harness({ hasUI: false, branch: [{ type: "custom", customType: "pistack-mode", data: { on: true } }] });
  try {
    await resumed.emit("session_start");
    const event = await resumed.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
    assert.ok(event.systemPromptOptions.sections["pistack-mode"], "rebuilt from the branch");
  } finally { resumed.dispose(); }
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
  const h = harness({ answers: ["unlimited — max thinking", "xai/grok-4.7", "claude-subscription/claude-opus-5-5"] });
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
