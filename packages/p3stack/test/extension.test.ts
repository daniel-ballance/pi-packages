import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import p3stack from "../extensions/p3stack/index.ts";
import type { Context } from "../extensions/p3stack/src/mode.ts";
import { candidates, DEFAULT_ROLES, thinkingFor } from "../extensions/p3stack/src/roles.ts";

const model = (provider: string, id: string, levels: Record<string, string | null> | undefined, reasoning = true) =>
  ({ provider, id, reasoning, thinkingLevelMap: levels });
const opus = model("claude-subscription", "claude-opus-5-5", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
const grok = model("xai", "grok-4.7", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null });

type Subagents = undefined | "old" | { spawnEnabled: boolean; models: string[] };
function harness({ mode = undefined as string | undefined, hasUI = true, answers = [] as (string | undefined)[], files = {} as Record<string, unknown>, trusted = false, branch = [] as unknown[], subagents = undefined as Subagents, t3 = undefined as unknown, parent = undefined as { provider: string; id: string } | undefined, extraTools = [] as { name: string; exposure?: string }[], factory = p3stack } = {}) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-ext-")), cwd = join(root, "project"), agentDir = join(root, "agent");
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
    cwd, hasUI, mode, model: parent, isProjectTrusted: () => trusted,
    executeTool: async (name: string, args: unknown): ReturnType<Context["executeTool"]> => {
      assert.equal(name, "mcp__t3-code__orchestrator_capabilities");
      assert.deepEqual(args, {});
      return {
        toolCall: { type: "toolCall", id: "call/1", name, arguments: args },
        result: { content: [{ type: "text", text: JSON.stringify(t3) }], structuredContent: t3, details: {} },
        isError: false,
      };
    },
    get ui() { if (!hasUI) throw new Error("touched ui without UI"); return ui; },
    modelRegistry: { getAvailable: () => [opus, grok] },
    sessionManager: { getBranch: () => branch },
  };
  factory({
    getThinkingLevel: () => "xhigh",
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    getAllTools: () => [...tools.values(), ...extraTools, ...subagents ? [{ name: "subagent_catalog" }] : [], ...t3 ? [{ name: "mcp__t3-code__orchestrator_capabilities" }] : []],
    events: { emit: (channel: string, data: { reply(value: unknown): void }) => { if (channel === "subagents:catalog" && subagents && subagents !== "old") data.reply(subagents); } },
  } as never);
  const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); return event; };
  const reminders = async (event: any) => { const out = []; for (const handler of handlers.get("before_agent_start") ?? []) { const result = await handler(event, ctx); if (result?.message) out.push(result.message); } return out; };
  const call = (name: string, args: unknown) => tools.get(name).execute("call", args, undefined, undefined, ctx);
  const command = (name: string, args = "") => commands.get(name).handler(args, ctx);
  const dispose = () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); };
  return { root, cwd, agentDir, ctx, tools, commands, emit, reminders, call, command, entries, notices, statuses, asked, dispose };
}
const text = (result: { content: { text: string }[] }) => result.content.map(part => part.text).join("\n");

test("each extension module registers its own job without loading unrelated features", async () => {
  const { registerMode } = await import("../extensions/p3stack/src/mode.ts");
  const { registerBrief } = await import("../extensions/p3stack/src/brief.ts");
  const { registerAsk } = await import("../extensions/p3stack/src/ask.ts");
  const { registerSetup } = await import("../extensions/p3stack/src/setup.ts");
  const { registerRoles } = await import("../extensions/p3stack/src/roles.ts");
  const mode = harness({ factory: pi => { const on = registerMode(pi, "router.md"); registerBrief(pi, on, "router.md", "agent.md"); } });
  try {
    assert.equal(mode.tools.size, 0);
    await mode.command("p3stack", "on");
    const event = { toolName: "subagent_spawn", input: { task: "Fix it." } };
    await mode.emit("tool_call", event);
    assert.match(event.input.task, /read agent\.md/);
  } finally { mode.dispose(); }
  for (const [factory, tool, command] of [[registerAsk, "ask_user", undefined], [registerRoles, "p3stack_roles", undefined], [registerSetup, undefined, "p3stack-setup"]] as const) {
    const h = harness({ factory });
    try {
      assert.deepEqual([...h.tools.keys()], tool ? [tool] : []);
      assert.deepEqual([...h.commands.keys()], command ? [command] : []);
    } finally { h.dispose(); }
  }
});

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

test("p3stack_roles answers with the role table as text, from the file or the default hints", async () => {
  const h = harness({ files: { "agent/p3stack.json": { budget: "large (xhigh)", roles: { "swarm workers": "xai/grok-4.7:xhigh" } } } });
  try {
    const result = await h.call("p3stack_roles", {});
    assert.match(text(result), /^Role defaults from .*agent\/p3stack\.json \(budget large \(xhigh\)\)/);
    assert.match(text(result), /swarm workers: xai\/grok-4\.7:xhigh\n/);
    assert.match(text(result), /judgment and prose: claude-subscription\/claude-opus-5-5:xhigh/);
    assert.equal(result.structuredContent.roles["swarm workers"], "xai/grok-4.7:xhigh");
    assert.equal(Object.keys(result.structuredContent.roles).length, Object.keys(DEFAULT_ROLES).length);
  } finally { h.dispose(); }
});

test("a trusted project's file wins over the personal one, and a broken file is reported, not used", async () => {
  const project = harness({ trusted: true, files: { "project/.pi/p3stack.json": { roles: { "bug-fix": "xai/grok-4.7:low" } }, "agent/p3stack.json": { roles: { "bug-fix": "xai/grok-4.7:high" } } } });
  try { assert.match(text(await project.call("p3stack_roles", {})), /bug-fix: xai\/grok-4\.7:low/); } finally { project.dispose(); }
  const untrusted = harness({ trusted: false, files: { "project/.pi/p3stack.json": { roles: { "bug-fix": "a/b:low" } } } });
  try {
    const result = await untrusted.call("p3stack_roles", {});
    assert.match(text(result), /skipped .*project\/\.pi\/p3stack\.json.*project is untrusted/);
    assert.match(text(result), /bug-fix: xai\/grok-4\.7:xhigh/);
  } finally { untrusted.dispose(); }
  const broken = harness({ files: { "agent/p3stack.json": { roles: { "bug-fix": 7 } } } });
  try {
    const result = await broken.call("p3stack_roles", {});
    assert.match(text(result), /ignored .*p3stack\.json: role "bug-fix" must be a model or a list of models/);
    assert.match(text(result), /bug-fix: xai\/grok-4\.7:xhigh/);
  } finally { broken.dispose(); }
});

test("roles resolve against the live allowlist, clamp thinking down, and report missing selections", async () => {
  const catalog = { spawnEnabled: true, models: ["xai/grok-4.7:high", "claude-subscription/claude-opus-5-5:xhigh"] };
  const h = harness({ subagents: catalog });
  try {
    const first = (await h.call("p3stack_roles", {})).structuredContent;
    assert.equal(first.roles["swarm workers"], "xai/grok-4.7:high");
    assert.equal(first.roles["judgment and prose"], "claude-subscription/claude-opus-5-5:xhigh");
    assert.deepEqual(first.roles["architect runners"], ["claude-subscription/claude-opus-5-5:xhigh", "xai/grok-4.7:high"]);
    catalog.models = ["xai/grok-4.7:low"];
    const second = (await h.call("p3stack_roles", {})).structuredContent;
    assert.equal(second.roles["swarm workers"], "xai/grok-4.7:low");
    assert.equal(second.roles["judgment and prose"], undefined);
    assert.match(second.problems.join("\n"), /judgment and prose.*no live catalog selection/);
  } finally { h.dispose(); }
});

test("a registered T3 catalog takes precedence and returns ready targets with advertised thinking options", async () => {
  const h = harness({ subagents: { spawnEnabled: true, models: [] }, t3: { providers: [
    { providerInstanceId: "pi-main", canRunChildTask: true, models: [
      { id: "xai/grok-4.7", options: [{ id: "thinkingLevel", type: "select", options: [{ id: "low" }, { id: "high" }] }] },
      { id: "claude-subscription/claude-opus-5-5", options: [{ id: "thinkingLevel", type: "select", options: [{ id: "xhigh" }] }] },
    ] },
    { providerInstanceId: "unavailable", canRunChildTask: false, models: [{ id: "claude-opus-5-5" }] },
  ] } });
  try {
    const result = (await h.call("p3stack_roles", {})).structuredContent;
    assert.deepEqual(result.roles["judgment and prose"], { providerInstanceId: "pi-main", model: "claude-subscription/claude-opus-5-5", options: [{ id: "thinkingLevel", value: "xhigh" }] });
    assert.deepEqual(result.roles["swarm workers"], { providerInstanceId: "pi-main", model: "xai/grok-4.7", options: [{ id: "thinkingLevel", value: "high" }] });
  } finally { h.dispose(); }
});

test("T3 bridge MCP envelopes resolve roles and preserve the inherited target without guessing options", async () => {
  const h = harness({ t3: { content: [], structuredContent: {
    inheritedProviderInstanceId: "pi-main", inheritedModel: "claude-subscription/claude-opus-5-5",
    providers: [{ providerInstanceId: "pi-main", canRunChildTask: true, models: [{ id: "claude-subscription/claude-opus-5-5" }] }],
  } }, files: { "agent/p3stack.json": { roles: { "bug-fix": "inherit-parent" } } } });
  try {
    const roles = (await h.call("p3stack_roles", {})).structuredContent.roles;
    assert.deepEqual(roles["judgment and prose"], { providerInstanceId: "pi-main", model: "claude-subscription/claude-opus-5-5" });
    assert.deepEqual(roles["bug-fix"], roles["judgment and prose"]);
  } finally { h.dispose(); }
});

test("Pi tool-call outcomes resolve T3 roles from structured MCP envelopes or text", async () => {
  const capabilities = { providers: [{ providerInstanceId: "pi-main", canRunChildTask: true, models: [
    { id: "claude-subscription/claude-opus-5-5", options: [{ id: "thinkingLevel", type: "select", options: [{ id: "xhigh" }] }] },
    { id: "xai/grok-4.7", options: [{ id: "thinkingLevel", type: "select", options: [{ id: "high" }] }] },
  ] }] };
  for (const structuredContent of [{ content: [], structuredContent: capabilities }, undefined]) {
    const h = harness({ t3: capabilities, subagents: { spawnEnabled: true, models: [] } });
    h.ctx.executeTool = async (name, args) => {
      assert.equal(name, "mcp__t3-code__orchestrator_capabilities");
      assert.deepEqual(args, {});
      return {
        toolCall: { type: "toolCall", id: "call/1", name, arguments: args },
        result: { content: [{ type: "text", text: JSON.stringify(capabilities) }], structuredContent, details: {} },
        isError: false,
      };
    };
    try {
      const result = await h.call("p3stack_roles", {});
      assert.deepEqual(result.structuredContent.roles["judgment and prose"], { providerInstanceId: "pi-main", model: "claude-subscription/claude-opus-5-5", options: [{ id: "thinkingLevel", value: "xhigh" }] });
      assert.equal(Object.keys(result.structuredContent.roles).length, 17);
      assert.deepEqual(result.structuredContent.problems, []);
    } finally { h.dispose(); }
  }
});

test("a failed Pi tool-call outcome reports the T3 failure and resolves the subagents allowlist", async () => {
  const capabilities = { providers: [{ providerInstanceId: "pi-main", canRunChildTask: true, models: [{ id: "claude-subscription/claude-opus-5-5" }] }] };
  const h = harness({ t3: capabilities, subagents: { spawnEnabled: true, models: ["claude-subscription/claude-opus-5-5:low", "xai/grok-4.7:low"] } });
  h.ctx.executeTool = async (name, args) => {
    assert.equal(name, "mcp__t3-code__orchestrator_capabilities");
    assert.deepEqual(args, {});
    return {
      toolCall: { type: "toolCall", id: "call/1", name, arguments: args },
      result: { content: [{ type: "text", text: "T3 unavailable" }], structuredContent: capabilities, details: {} },
      isError: true,
    };
  };
  try {
    const result = await h.call("p3stack_roles", {});
    assert.equal(result.structuredContent.roles["judgment and prose"], "claude-subscription/claude-opus-5-5:low");
    assert.equal(result.structuredContent.roles["swarm workers"], "xai/grok-4.7:low");
    assert.equal(Object.keys(result.structuredContent.roles).length, 17);
    assert.equal(result.structuredContent.problems.length, 1);
    assert.match(text(result), /T3 catalog call failed/);
  } finally { h.dispose(); }
});

test("inherit-parent resolves to an exact permitted identity and disabled catalogs never invent a model", async () => {
  const h = harness({ parent: { provider: "claude-subscription", id: "claude-opus-5-5" }, files: { "agent/p3stack.json": { roles: { "bug-fix": "inherit-parent" } } } });
  try { assert.equal((await h.call("p3stack_roles", {})).structuredContent.roles["bug-fix"], "claude-subscription/claude-opus-5-5:xhigh"); } finally { h.dispose(); }
  for (const subagents of ["old", { spawnEnabled: false, models: ["xai/grok-4.7:xhigh"] }] as Subagents[]) {
    const h = harness({ subagents });
    try {
      const result = (await h.call("p3stack_roles", {})).structuredContent;
      assert.deepEqual(result.roles, {});
      assert.ok(result.problems.length);
    } finally { h.dispose(); }
  }
});

test("the mode toggle persists, adds a prompt section while on, and shows only in the terminal", async () => {
  const h = harness();
  try {
    await h.command("p3stack", "on");
    assert.deepEqual(h.entries.at(-1), { customType: "p3stack", data: { on: true } });
    assert.deepEqual(h.statuses, [], "T3 shows no status, so none is set outside the terminal");
    const event = await h.emit("before_agent_start", { messageType: "user", systemPromptOptions: { sections: {} } });
    const section = event.systemPromptOptions.sections["p3stack"];
    assert.match(section, /^Read .*skills\/poteto-mode\/SKILL\.md and follow it\.$/);
    assert.doesNotMatch(section, /Role models|bug-fix|grok|claude/);
    assert.equal(section.split("\n").length, 1, "only the router belongs in the section");
    const reminders = await h.reminders({ messageType: "user", systemPromptOptions: { sections: {} } });
    assert.equal(reminders.length, 1, "each user turn gets a reminder beside the request");
    assert.equal(reminders[0].display, false);
    assert.match(reminders[0].content, /^\[poteto-mode is on\] Before anything else, route this request\. Read .*poteto-mode\/SKILL\.md/);
    assert.match(reminders[0].content, /call `p3stack_roles` for the role models/);
    assert.doesNotMatch(reminders[0].content, /role models above/);
    assert.deepEqual(await h.reminders({ messageType: "custom", systemPromptOptions: { sections: {} } }), [], "not for runs a custom message started");
    await h.command("p3stack", "off");
    const off = await h.emit("before_agent_start", { systemPromptOptions: { sections: { "p3stack": "stale" } } });
    assert.equal(off.systemPromptOptions.sections["p3stack"], undefined);
    assert.deepEqual(await h.reminders({ messageType: "user", systemPromptOptions: { sections: {} } }), [], "no reminder while off");
  } finally { h.dispose(); }
  const tui = harness({ mode: "tui" });
  try {
    await tui.emit("session_start");
    await tui.command("p3stack", "on");
    assert.deepEqual(tui.statuses.at(-1), ["p3stack", "p3stack on"]);
    await tui.command("p3stack", "off");
    assert.deepEqual(tui.statuses.at(-1), ["p3stack", undefined]);
  } finally { tui.dispose(); }
  const resumed = harness({ hasUI: false, branch: [{ type: "custom", customType: "p3stack", data: { on: true } }] });
  try {
    await resumed.emit("session_start");
    const event = await resumed.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
    assert.ok(event.systemPromptOptions.sections["p3stack"], "rebuilt from the branch");
  } finally { resumed.dispose(); }
});

test("while the mode is on, delegated briefs start with the poteto-agent recipe, once", async () => {
  const h = harness();
  try {
    const spawn: any = { toolName: "subagent_spawn", input: { task: "Fix the bug." } };
    await h.emit("tool_call", spawn);
    assert.equal(spawn.input.task, "Fix the bug.", "mode off: untouched");
    await h.command("p3stack", "on");
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
    await h.command("p3stack", "on");
    const reader: any = { toolName: "subagent_spawn", input: { task: "Audit stats.ts.", tools: ["read", "bash", "grep"] } };
    await h.emit("tool_call", reader);
    assert.match(reader.input.task, /^You are a read-only delegate in a poteto-mode run\. .*Do not read the poteto-mode skill.*\n\nAudit stats\.ts\.$/s);
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

test("T3 research and review roles get a short recipe while writing and unspecified roles keep the full recipe", async () => {
  const h = harness();
  try {
    await h.command("p3stack", "on");
    for (const role of ["research", "review", "implement", undefined]) {
      const event = { toolName: "mcp__t3-code__delegate_task", input: { role, task: "Inspect the change." } };
      await h.emit("tool_call", event);
      if (role === "research" || role === "review") {
        assert.match(event.input.task, /^You are a read-only delegate/);
        assert.doesNotMatch(event.input.task, /poteto-agent\.md/);
      } else assert.match(event.input.task, /^Before any work, read .*poteto-agent\.md/);
      const once = event.input.task;
      await h.emit("tool_call", event);
      assert.equal(event.input.task, once);
    }
  } finally { h.dispose(); }
});

test("doctor records every T3 tool exposure, the bridge hash, and explicit provider-before-bridge ordering", async () => {
  const h = harness({ extraTools: [
    { name: "mcp__t3-code__delegate_task", exposure: "direct" },
    { name: "mcp__t3-code__hidden", exposure: "hidden" },
    { name: "mcp__other__tool", exposure: "codemode" },
  ] });
  const argv = process.argv, previous = process.env.T3_PI_MCP_EXTENSION_PATH;
  const bridge = join(h.root, "bridge.ts"), provider = join(h.root, "claude-subscription", "index.ts");
  writeFileSync(bridge, "bridge content\n");
  process.env.T3_PI_MCP_EXTENSION_PATH = bridge;
  try {
    for (const [args, expected] of [
      [["-e", provider, "--extension", bridge], true],
      [[`--extension=${bridge}`, `--extension=${provider}`], false],
      [["a prompt naming", provider, bridge], false],
    ] as [string[], boolean][]) {
      process.argv = ["node", "pi", ...args];
      await h.command("p3stack", "doctor");
      const report = JSON.parse(readFileSync(join(h.agentDir, "p3stack", "t3-contract.json"), "utf8"));
      assert.deepEqual(report.tools, [{ name: "mcp__t3-code__delegate_task", exposure: "direct" }, { name: "mcp__t3-code__hidden", exposure: "hidden" }]);
      assert.equal(report.extension.sha256, createHash("sha256").update("bridge content\n").digest("hex"));
      assert.equal(report.claudeSubscriptionBeforeBridge, expected);
    }
  } finally {
    process.argv = argv;
    if (previous === undefined) delete process.env.T3_PI_MCP_EXTENSION_PATH; else process.env.T3_PI_MCP_EXTENSION_PATH = previous;
    h.dispose();
  }
  const terminal = harness({ hasUI: false });
  delete process.env.T3_PI_MCP_EXTENSION_PATH;
  try {
    await terminal.command("p3stack", "doctor");
    const report = JSON.parse(readFileSync(join(terminal.agentDir, "p3stack", "t3-contract.json"), "utf8"));
    assert.deepEqual(report.tools, []);
    assert.equal(report.extension.sha256, null);
    assert.equal(report.claudeSubscriptionBeforeBridge, false);
  } finally {
    if (previous === undefined) delete process.env.T3_PI_MCP_EXTENSION_PATH; else process.env.T3_PI_MCP_EXTENSION_PATH = previous;
    terminal.dispose();
  }
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

function asTerminal() {
  const previous = process.env.T3_MCP_URL;
  delete process.env.T3_MCP_URL;
  return () => { if (previous !== undefined) process.env.T3_MCP_URL = previous; };
}

test("/p3stack-setup maps a budget and two models onto every role and writes the file", async () => {
  const restore = asTerminal();
  const h = harness({ answers: ["unlimited, max thinking", "xai/grok-4.7:xhigh", "claude-subscription/claude-opus-5-5:max"] });
  try {
    await h.command("p3stack-setup");
    const written = JSON.parse(readFileSync(join(h.agentDir, "p3stack.json"), "utf8"));
    assert.equal(written.budget, "unlimited (max)");
    assert.equal(written.roles["swarm workers"], "xai/grok-4.7:xhigh");
    assert.equal(written.roles["judgment and prose"], "claude-subscription/claude-opus-5-5:max");
    assert.deepEqual(written.roles["interrogate reviewers"], ["claude-subscription/claude-opus-5-5:max", "xai/grok-4.7:xhigh"]);
    assert.match(h.notices.at(-1)![0], /Wrote .*p3stack\.json/);
  } finally { h.dispose(); restore(); }
});

test("/p3stack-setup defers to the skill under T3 and does nothing without a UI", async () => {
  const previous = process.env.T3_MCP_URL;
  process.env.T3_MCP_URL = "http://127.0.0.1:1/mcp";
  const h = harness();
  try {
    await h.command("p3stack-setup");
    assert.match(h.notices.at(-1)![0], /\/skill:setup-pstack/);
    assert.deepEqual(h.asked, []);
  } finally { h.dispose(); if (previous === undefined) delete process.env.T3_MCP_URL; else process.env.T3_MCP_URL = previous; }
  const headless = harness({ hasUI: false });
  try { await headless.command("p3stack-setup"); } finally { headless.dispose(); }
});

test("/p3stack-setup offers only models the subagents policy permits, and never writes one it cannot check", async () => {
  const restore = asTerminal();
  const run = async (subagents: Subagents, answers: string[], check: (h: ReturnType<typeof harness>, written: unknown) => void) => {
    const h = harness({ subagents, answers });
    try {
      await h.command("p3stack-setup");
      let written: unknown;
      try { written = JSON.parse(readFileSync(join(h.agentDir, "p3stack.json"), "utf8")); } catch { written = undefined; }
      check(h, written);
    } finally { h.dispose(); }
  };
  try {
    await run({ spawnEnabled: true, models: ["xai/grok-4.7:high", "xai/grok-4.7:xhigh"] }, ["large, xhigh thinking", "xai/grok-4.7:xhigh", "xai/grok-4.7:xhigh"], (h, written) => {
      assert.match(h.asked[1]!, /\[xai\/grok-4\.7:xhigh\]$/, "Opus is authenticated but not permitted");
      assert.equal((written as { roles: Record<string, string> }).roles["bug-fix"], "xai/grok-4.7:xhigh");
    });
    await run("old", [], (h, written) => { assert.match(h.notices.at(-1)![0], /\/skill:setup-pstack/); assert.equal(written, undefined); });
    await run({ spawnEnabled: false, models: [] }, [], (h, written) => { assert.match(h.notices.at(-1)![0], /does not permit spawning/); assert.equal(written, undefined); });
    await run({ spawnEnabled: true, models: ["xai/grok-4.7:xhigh"] }, ["small, medium thinking"], (h, written) => {
      assert.match(h.notices.at(-1)![0], /No permitted model offers thinking at or below medium/);
      assert.equal(written, undefined);
    });
  } finally { restore(); }
});
