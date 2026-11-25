import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { ExtensionRunner, FooterComponent, initTheme, SessionManager, SettingsManager, type ExtensionContext, type ExtensionToolContext, type ExtensionUIContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, stripTerminalSequences, truncateToWidth, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import p3stack from "../extensions/p3stack/index.ts";
import { candidates, DEFAULT_ROLES, family, thinkingFor } from "../extensions/p3stack/src/roles.ts";

const model = (provider: string, id: string, levels: Record<string, string | null> | undefined, reasoning = true) =>
  ({ provider, id, reasoning, thinkingLevelMap: levels });
const opus = model("claude", "claude-opus-5-5", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
const grok = model("xai", "grok-4.7", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null });

type Subagents = undefined | "old" | { spawnEnabled: boolean; models: string[] };
type LoadedCommand = { name: string; source: string; sourceInfo: { path: string } };
function harness({ mode = undefined as string | undefined, hasUI = true, answers = [] as (string | undefined)[], files = {} as Record<string, unknown>, trusted = false, branch = [] as unknown[], subagents = undefined as Subagents, t3 = undefined as Awaited<ReturnType<ExtensionToolContext["executeTool"]>>["result"]["structuredContent"], parent = undefined as { provider: string; id: string } | undefined, extraTools = [] as { name: string; exposure?: string }[], commands: loadedCommands = [] as LoadedCommand[], factory = p3stack } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "p3stack-ext-"))), cwd = join(root, "project"), agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true }); mkdirSync(agentDir);
  for (const [path, data] of Object.entries(files)) writeFileSync(join(root, path), JSON.stringify(data));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const tools = new Map<string, any>(), commands = new Map<string, any>(), handlers = new Map<string, Function[]>();
  const entries: unknown[] = [], notices: [string, string?][] = [], statuses: [string, string | undefined][] = [], footers: Parameters<ExtensionUIContext["setFooter"]>[0][] = [], asked: string[] = [];
  const ui = {
    select: async (title: string, options: string[]) => { asked.push(`${title} [${options.join(" | ")}]`); return answers.shift(); },
    input: async (title: string) => { asked.push(title); return answers.shift(); },
    confirm: async (title: string) => { asked.push(title); return answers.shift() === "yes"; },
    notify: (message: string, type?: string) => notices.push([message, type]),
    setStatus: (key: string, text?: string) => statuses.push([key, text]),
    setFooter: (factory: Parameters<ExtensionUIContext["setFooter"]>[0]) => footers.push(factory),
  };
  const ctx = {
    cwd, hasUI, mode, model: parent, isProjectTrusted: () => trusted,
    executeTool: async (name: string, args: unknown): ReturnType<ExtensionToolContext["executeTool"]> => {
      assert.equal(name, "mcp__t3-code__orchestrator_capabilities");
      assert.deepEqual(args, {});
      return {
        toolCall: { type: "toolCall", id: "call/1", name, arguments: args },
        result: { content: [{ type: "text", text: JSON.stringify(t3) }], structuredContent: t3, details: {} },
        isError: false,
      };
    },
    get ui() { if (!hasUI) throw new Error("touched ui without UI"); return ui; },
    modelRegistry: { getAvailable: () => [opus, grok], isUsingOAuth: () => false, getProvider: () => undefined },
    getContextUsage: (): ReturnType<ExtensionContext["getContextUsage"]> => undefined,
    sessionManager: { getBranch: () => branch, getEntries: (): SessionEntry[] => [], getSessionName: (): string | undefined => undefined },
  };
  factory({
    getThinkingLevel: () => "xhigh",
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    getCommands: () => loadedCommands,
    getAllTools: () => [...tools.values(), ...extraTools, ...subagents ? [{ name: "subagent_catalog" }] : [], ...t3 ? [{ name: "mcp__t3-code__orchestrator_capabilities" }] : []],
    events: { on: () => () => {}, emit: (channel: string, data: { reply(value: unknown): void }) => { if (channel === "subagents:catalog" && subagents && subagents !== "old") data.reply(subagents); } },
  } as never);
  const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); return event; };
  const reminders = async (event: any) => { const out = []; for (const handler of handlers.get("before_agent_start") ?? []) { const result = await handler(event, ctx); if (result?.message) out.push(result.message); } return out; };
  const results = async (name: string, event: any) => { const out = []; for (const handler of handlers.get(name) ?? []) out.push(await handler(event, ctx)); return out.filter(Boolean); };
  const call = (name: string, args: unknown) => tools.get(name).execute("call", args, undefined, undefined, ctx);
  const command = (name: string, args = "") => commands.get(name).handler(args, ctx);
  const dispose = () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); };
  return { root, cwd, agentDir, ctx, tools, commands, handlers, emit, results, reminders, call, command, entries, notices, statuses, footers, asked, dispose };
}
function hostHarness(host: "terminal" | "t3", options?: Parameters<typeof harness>[0]) {
  const previous = process.env.T3_MCP_URL;
  if (host === "terminal") delete process.env.T3_MCP_URL;
  else process.env.T3_MCP_URL = "http://127.0.0.1:1/mcp";
  const h = harness(options);
  return { ...h, dispose() {
    h.dispose();
    if (previous === undefined) delete process.env.T3_MCP_URL; else process.env.T3_MCP_URL = previous;
  } };
}
const text = (result: { content: { text: string }[] }) => result.content.map(part => part.text).join("\n");

test("each extension module registers its own job without loading unrelated features", async () => {
  const { registerMode } = await import("../extensions/p3stack/src/mode.ts");
  const { registerBrief } = await import("../extensions/p3stack/src/brief.ts");
  const { registerAsk } = await import("../extensions/p3stack/src/ask.ts");
  const { registerSetup } = await import("../extensions/p3stack/src/setup.ts");
  const { registerRoles } = await import("../extensions/p3stack/src/roles.ts");
  const mode = hostHarness("terminal", { factory: pi => { const on = registerMode(pi, "router.md"); registerBrief(pi, on, "router.md", "agent.md"); } });
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
  assert.deepEqual(candidates("small", [opus, highOnly]), ["claude/claude-opus-5-5:medium"]);
});

test("with a subagents catalog, only its identities are offered, at the highest level within the budget", () => {
  const catalog = ["xai/grok-4.7:high", "xai/grok-4.7:low", "p/deep:xhigh", "malformed"];
  assert.deepEqual(candidates("medium", [opus, grok], catalog), ["xai/grok-4.7:high"]);
  assert.deepEqual(candidates("unlimited", [], catalog), ["xai/grok-4.7:high", "p/deep:xhigh"]);
});

test("p3stack_roles answers with the role table as text, from the file or the default hints", async t => {
  t.after(asHost("cli"));
  const h = harness({ files: { "agent/p3stack.json": { budget: "large (xhigh)", roles: { "swarm workers": "xai/grok-4.7:xhigh" } } } });
  try {
    const result = await h.call("p3stack_roles", {});
    assert.match(text(result), /^Role defaults from .*agent\/p3stack\.json \(budget large \(xhigh\)\)/);
    assert.match(text(result), /swarm workers: xai\/grok-4\.7:xhigh\n/);
    assert.match(text(result), /judgment and prose: claude\/claude-opus-5-5:xhigh/);
    assert.equal(result.structuredContent.roles["swarm workers"], "xai/grok-4.7:xhigh");
    assert.equal(Object.keys(result.structuredContent.roles).length, Object.keys(DEFAULT_ROLES).length);
  } finally { h.dispose(); }
});

test("a trusted project's file wins over the personal one, and a broken file is reported, not used", async t => {
  t.after(asHost("cli"));
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
    assert.match(text(result), /ignored .*p3stack\.json: role "bug-fix" must be a model, a list of models, or \{ primary, fallbacks\? \}/);
    assert.match(text(result), /bug-fix: xai\/grok-4\.7:xhigh/);
  } finally { broken.dispose(); }
});

test("roles resolve against the live allowlist, clamp thinking down, and name substitutions", async t => {
  t.after(asHost("cli"));
  const catalog = { spawnEnabled: true, models: ["xai/grok-4.7:high", "claude/claude-opus-5-5:xhigh"] };
  const h = harness({ subagents: catalog });
  try {
    const first = (await h.call("p3stack_roles", {})).structuredContent;
    assert.equal(first.roles["swarm workers"], "xai/grok-4.7:high");
    assert.equal(first.roles["judgment and prose"], "claude/claude-opus-5-5:xhigh");
    assert.deepEqual(first.roles["architect runners"], ["claude/claude-opus-5-5:xhigh", "xai/grok-4.7:high"]);
    catalog.models = ["xai/grok-4.7:low"];
    const second = (await h.call("p3stack_roles", {})).structuredContent;
    assert.equal(second.roles["swarm workers"], "xai/grok-4.7:low");
    assert.equal(second.roles["judgment and prose"], "xai/grok-4.7:low");
    assert.match(second.problems.join("\n"), /judgment and prose.*substituted xai\/grok-4\.7:low for claude-opus-5-5-xhigh/);
  } finally { h.dispose(); }
});

test("distinctFrom moves each role off the author's family when the catalog offers another, and says so", async t => {
  t.after(asHost("cli"));
  assert.equal(family("claude/claude-opus-5-5:xhigh"), "claude");
  assert.equal(family("xai/grok-4.7"), "grok");
  assert.equal(family("openai-codex/gpt-6-astra"), "gpt");
  const catalog = { spawnEnabled: true, models: ["xai/grok-4.7:high", "claude/claude-opus-5-5:xhigh", "openai-codex/gpt-6-astra:xhigh"] };
  const h = harness({ subagents: catalog });
  try {
    const plain = (await h.call("p3stack_roles", {})).structuredContent;
    assert.equal(plain.roles["judgment and prose"], "claude/claude-opus-5-5:xhigh");
    const result = await h.call("p3stack_roles", { distinctFrom: "claude/claude-opus-5-5:xhigh" });
    const roles = result.structuredContent.roles;
    assert.equal(roles["judgment and prose"], "openai-codex/gpt-6-astra:xhigh", "the closest level outside the family");
    assert.equal(roles["swarm workers"], "xai/grok-4.7:high", "already outside the family");
    assert.deepEqual(roles["interrogate reviewers"], ["openai-codex/gpt-6-astra:xhigh", "xai/grok-4.7:high"]);
    assert.match(text(result), /judgment and prose.*substituted openai-codex\/gpt-6-astra:xhigh for claude-opus-5-5-xhigh to differ from claude\//);
    catalog.models = ["claude/claude-opus-5-5:xhigh"];
    const only = await h.call("p3stack_roles", { distinctFrom: "claude" });
    assert.equal(only.structuredContent.roles["judgment and prose"], "claude/claude-opus-5-5:xhigh");
    assert.match(text(only), /judgment and prose.*no model outside the claude family is offered/);
  } finally { h.dispose(); }
});

test("under T3, roles return ready targets with advertised thinking options", async t => {
  t.after(asHost("t3"));
  const h = harness({ subagents: { spawnEnabled: true, models: [] }, t3: { providers: [
    { providerInstanceId: "pi-main", canRunChildTask: true, models: [
      { id: "xai/grok-4.7", options: [{ id: "thinkingLevel", type: "select", options: [{ id: "low" }, { id: "high" }] }] },
      { id: "claude/claude-opus-5-5", options: [{ id: "thinkingLevel", type: "select", options: [{ id: "xhigh" }] }] },
    ] },
    { providerInstanceId: "unavailable", canRunChildTask: false, models: [{ id: "claude-opus-5-5" }] },
  ] } });
  try {
    const result = (await h.call("p3stack_roles", {})).structuredContent;
    assert.deepEqual(result.roles["judgment and prose"], { providerInstanceId: "pi-main", model: "claude/claude-opus-5-5", options: [{ id: "thinkingLevel", value: "xhigh" }] });
    assert.deepEqual(result.roles["swarm workers"], { providerInstanceId: "pi-main", model: "xai/grok-4.7", options: [{ id: "thinkingLevel", value: "high" }] });
  } finally { h.dispose(); }
});

test("T3 bridge MCP envelopes distinguish inheriting the parent from requesting an unoffered level", async t => {
  t.after(asHost("t3"));
  const h = harness({ t3: { content: [], structuredContent: {
    inheritedProviderInstanceId: "pi-main", inheritedModel: "claude/claude-opus-5-5",
    providers: [{ providerInstanceId: "pi-main", canRunChildTask: true, models: [{ id: "claude/claude-opus-5-5" }] }],
  } }, files: { "agent/p3stack.json": { roles: { "bug-fix": "inherit-parent" } } } });
  try {
    const roles = (await h.call("p3stack_roles", {})).structuredContent.roles;
    assert.equal(roles["judgment and prose"], undefined);
    assert.equal(roles["bug-fix"], null, "omit target to inherit, including the parent's settings");
  } finally { h.dispose(); }
});

test("Pi tool-call outcomes resolve T3 roles from structured MCP envelopes or text", async t => {
  t.after(asHost("t3"));
  const capabilities = { providers: [{ providerInstanceId: "pi-main", canRunChildTask: true, models: [
    { id: "claude/claude-opus-5-5", options: [{ id: "thinkingLevel", type: "select", options: [{ id: "xhigh" }] }] },
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
      assert.deepEqual(result.structuredContent.roles["judgment and prose"], { providerInstanceId: "pi-main", model: "claude/claude-opus-5-5", options: [{ id: "thinkingLevel", value: "xhigh" }] });
      assert.equal(Object.keys(result.structuredContent.roles).length, 17);
      assert.match(result.structuredContent.problems.join("\n"), /grok-4\.7:high.*grok-4\.7-xhigh-fast/);
    } finally { h.dispose(); }
  }
});

test("T3 capability receipts and failed delegates update the role cache under either tool name", async t => {
  t.after(asHost("t3"));
  for (const prefix of ["mcp__t3-code__", "mcp__t3_code__"]) {
    const catalog = (id: string) => ({ providers: [{ providerInstanceId: id, canRunChildTask: true, models: [
      { id: "claude/claude-opus-5-5", options: [{ id: "thinkingLevel", values: ["xhigh"] }] },
    ] }] });
    const h = harness({ t3: catalog("refetched") });
    const selected = async () => (await h.call("p3stack_roles", {})).structuredContent.roles["judgment and prose"].providerInstanceId;
    try {
      assert.equal(await selected(), "refetched");
      await h.emit("tool_result", { toolName: prefix + "orchestrator_capabilities", input: {}, structuredContent: catalog("observed") });
      assert.equal(await selected(), "observed");
      await h.emit("tool_result", { toolName: prefix + "delegate_task", isError: true });
      assert.equal(await selected(), "refetched");
    } finally { h.dispose(); }
  }
});

test("a failed T3 catalog call blocks every role even with a registered subagents allowlist", async t => {
  t.after(asHost("t3"));
  const capabilities = { providers: [{ providerInstanceId: "pi-main", canRunChildTask: true, models: [{ id: "claude/claude-opus-5-5" }] }] };
  const h = harness({ t3: capabilities, subagents: { spawnEnabled: true, models: ["claude/claude-opus-5-5:low", "xai/grok-4.7:low"] } });
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
    assert.deepEqual(result.structuredContent.roles, {});
    assert.match(text(result), /T3 catalog unavailable/);
    for (const role of Object.keys(DEFAULT_ROLES)) assert.ok(text(result).includes(role));
  } finally { h.dispose(); }
});

test("inherit-parent resolves to an exact permitted identity and disabled catalogs never invent a model", async t => {
  t.after(asHost("cli"));
  const h = harness({ parent: { provider: "claude", id: "claude-opus-5-5" }, files: { "agent/p3stack.json": { roles: { "bug-fix": "inherit-parent" } } } });
  try { assert.equal((await h.call("p3stack_roles", {})).structuredContent.roles["bug-fix"], "claude/claude-opus-5-5:xhigh"); } finally { h.dispose(); }
  for (const subagents of ["old", { spawnEnabled: false, models: ["xai/grok-4.7:xhigh"] }] as Subagents[]) {
    const h = harness({ subagents });
    try {
      const result = (await h.call("p3stack_roles", {})).structuredContent;
      assert.deepEqual(result.roles, {});
      assert.ok(result.problems.length);
    } finally { h.dispose(); }
  }
});

test("the mode toggle persists, adds only the router section and reminds the model beside user requests", async () => {
  const h = hostHarness("terminal");
  try {
    await h.command("p3stack", "on");
    assert.deepEqual(h.entries.at(-1), { customType: "p3stack", data: { on: true, grant: "default" } });
    assert.deepEqual(h.footers, [], "no footer is set outside the terminal");
    assert.deepEqual(h.notices.at(-1), ["p3stack is on (default grant).", "info"]);
    const event = await h.emit("before_agent_start", { messageType: "user", systemPromptOptions: { sections: {} } });
    const section = event.systemPromptOptions.sections["p3stack"];
    assert.match(section, /^Read .*skills\/p3stack-mode\/SKILL\.md and follow it\. Grant: default\. Host: terminal\.$/);
    assert.doesNotMatch(section, /Role models|bug-fix|grok|claude/);
    assert.equal(section.split("\n").length, 1, "only the router belongs in the section");
    const reminders = await h.reminders({ messageType: "user", systemPromptOptions: { sections: {} } });
    assert.equal(reminders.length, 1, "each user turn gets a reminder beside the request");
    assert.equal(reminders[0].display, false);
    assert.match(reminders[0].content, /automated note from the p3stack extension, not from the user/i);
    assert.match(reminders[0].content, /route this request: read .*p3stack-mode\/SKILL\.md unless its text is already in your context/i);
    assert.match(reminders[0].content, /If the user's message answers, approves or corrects the task already in progress, continue that task instead/);
    assert.match(reminders[0].content, /p3stack_roles/);
    assert.deepEqual(await h.reminders({ messageType: "custom", systemPromptOptions: { sections: {} } }), [], "not for runs a custom message started");
    await h.command("p3stack", "off");
    assert.deepEqual(h.notices.at(-1), ["p3stack is off.", "info"]);
    const off = await h.emit("before_agent_start", { systemPromptOptions: { sections: { "p3stack": "stale" } } });
    assert.equal(off.systemPromptOptions.sections["p3stack"], undefined);
    assert.deepEqual(await h.reminders({ messageType: "user", systemPromptOptions: { sections: {} } }), [], "no reminder while off");
  } finally { h.dispose(); }
  const resumed = harness({ hasUI: false, branch: [{ type: "custom", customType: "p3stack", data: { on: true } }] });
  try {
    await resumed.emit("session_start");
    const event = await resumed.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
    assert.ok(event.systemPromptOptions.sections["p3stack"], "rebuilt from the branch");
  } finally { resumed.dispose(); }
});

test("Pi keeps the router, grant and host after an earlier handler forces a user or custom request's prompt", async () => {
  for (const host of ["terminal", "t3"] as const) {
    const h = hostHarness(host);
    try {
      await h.command("p3stack", "on autonomous");
      const earlier = new Map([["before_agent_start", [() => ({ systemPrompt: "Earlier forced prompt" })]]]);
      const runner = { extensions: [{ path: "first", handlers: earlier }, { path: "p3stack", handlers: h.handlers }],
        createContext: () => h.ctx, emitError: assert.fail };
      for (const trigger of [
        { messageType: "user", prompt: "Go ahead" },
        { messageType: "custom", message: { role: "custom", customType: "completion", content: "Done", display: true, timestamp: 1 } },
      ] as const) {
        const { systemPromptOptions, messages } = await ExtensionRunner.prototype.emitBeforeAgentStart.call(runner as never, trigger, { cwd: h.cwd });
        assert.match(systemPromptOptions.forceSystemPrompt!, new RegExp(`^Earlier forced prompt\\n\\nRead .*p3stack-mode/SKILL\\.md and follow it\\. Grant: full-autonomy\\. Host: ${host}\\.$`));
        assert.equal(messages.length, trigger.messageType === "user" ? 1 : 0);
      }
    } finally { h.dispose(); }
  }
});

test("grant while off cannot arm the next run", async () => {
  const h = harness();
  try {
    for (const args of ["grant autonomous", "grant"]) {
      await h.command("p3stack", args);
      assert.deepEqual(h.entries, []);
      assert.match(h.notices.at(-1)![0], /p3stack is off.*\/p3stack on autonomous/i);
    }
    await h.command("p3stack", "on");
    assert.deepEqual(h.entries.at(-1), { customType: "p3stack", data: { on: true, grant: "default" } });
  } finally { h.dispose(); }
});

test("the grant is explicit mode state: set with on or grant, persisted, injected, and rejected when malformed", async () => {
  const h = hostHarness("t3");
  try {
    await h.command("p3stack", "on autonomous");
    assert.deepEqual(h.entries.at(-1), { customType: "p3stack", data: { on: true, grant: "autonomous" } });
    assert.deepEqual(h.notices.at(-1), ["p3stack is on (full-autonomy grant).", "info"]);
    let event = await h.emit("before_agent_start", { messageType: "user", systemPromptOptions: { sections: {} } });
    assert.match(event.systemPromptOptions.sections["p3stack"], / Grant: full-autonomy\. Host: t3\.$/);
    await h.command("p3stack", "grant default");
    assert.deepEqual(h.entries.at(-1), { customType: "p3stack", data: { on: true, grant: "default" } });
    event = await h.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
    assert.match(event.systemPromptOptions.sections["p3stack"], / Grant: default\. Host: t3\.$/);
    await h.command("p3stack", "grant autonomous");
    await h.command("p3stack", "off");
    await h.command("p3stack", "on");
    assert.deepEqual(h.entries.at(-1), { customType: "p3stack", data: { on: true, grant: "autonomous" } }, "bare on keeps the last grant");
    const count = h.entries.length;
    for (const bad of ["on everything", "grant", "grant yes", "off now", "on autonomous extra"]) {
      await h.command("p3stack", bad);
      assert.match(h.notices.at(-1)![0], /^Usage: \/p3stack on \[default\|autonomous\]/, bad);
    }
    assert.equal(h.entries.length, count, "malformed commands change nothing");
    await h.command("p3stack", "status");
    assert.deepEqual(h.notices.at(-1), ["p3stack is on (full-autonomy grant).", "info"]);
  } finally { h.dispose(); }
  for (const [data, expected] of [[{ on: true, grant: "autonomous" }, "full-autonomy"], [{ on: true }, "default"], [{ on: true, grant: "bogus" }, "default"]] as const) {
    const resumed = harness({ hasUI: false, branch: [{ type: "custom", customType: "p3stack", data }] });
    try {
      await resumed.emit("session_start");
      const event = await resumed.emit("before_agent_start", { systemPromptOptions: { sections: {} } });
      assert.match(event.systemPromptOptions.sections["p3stack"], new RegExp(`Grant: ${expected}\\. Host:`), JSON.stringify(data));
    } finally { resumed.dispose(); }
  }
});

const delegation = { terminal: "subagent_spawn", t3: "mcp__t3-code__delegate_task" } as const;
for (const host of ["terminal", "t3"] as const) {
  test(`${host} decorates only its native delegation tool, only while on`, async () => {
    const h = hostHarness(host);
    const task = "Inspect the importer.";
    try {
      const local = { toolName: delegation[host], input: { task } };
      await h.emit("tool_call", local);
      assert.equal(local.input.task, task);
      await h.command("p3stack", "on");
      const foreign = { toolName: delegation[host === "terminal" ? "t3" : "terminal"], input: { task } };
      await h.emit("tool_call", foreign);
      assert.equal(foreign.input.task, task);
      const [blocked] = await h.results("tool_call", local);
      if (host === "terminal") assert.match(local.input.task, /Grant: default\./);
      else { assert.equal(blocked.block, true); assert.equal(local.input.task, task); }
    } finally { h.dispose(); }
  });

  if (host === "terminal") test(`${host} replaces only a leading brief header and uses the current grant`, async () => {
    const h = hostHarness(host);
    const task = `\nUpdate the example citing ${join(import.meta.dirname, "../agents/poteto-agent.md")}.\n\nKeep this spacing.\n`;
    const event = { toolName: delegation[host], input: { task } };
    try {
      await h.command("p3stack", "on autonomous");
      await h.emit("tool_call", event);
      assert.match(event.input.task, /^<p3stack-brief>Grant: full-autonomy\./);
      assert.ok(event.input.task.endsWith("</p3stack-brief>\n\n" + task));
      const first = event.input.task;
      await h.emit("tool_call", event);
      assert.equal(event.input.task, first);
      await h.command("p3stack", "grant default");
      event.input.task = "\n" + first;
      await h.emit("tool_call", event);
      assert.equal(event.input.task, first.replace("Grant: full-autonomy.", "Grant: default."));
      for (const separator of ["\r\n\r\n", "\n", " ", ""]) {
        event.input.task = first.slice(0, first.indexOf("</p3stack-brief>") + "</p3stack-brief>".length).replaceAll("\n", "\r\n") + separator + "Update it.";
        await h.emit("tool_call", event);
        assert.deepEqual(event.input.task.match(/Grant: [\w-]+\./g), ["Grant: default."]);
        assert.ok(event.input.task.endsWith("Update it."));
      }
      event.input.task = "Discuss this quoted brief:\n" + first;
      await h.emit("tool_call", event);
      assert.ok(event.input.task.endsWith("Discuss this quoted brief:\n" + first));
    } finally { h.dispose(); }
  });

  if (host === "terminal") test(`${host} sends the full stance at the limit and blocks with the exact excess above it`, async () => {
    const h = hostHarness(host);
    const limit = 30_000;
    try {
      await h.command("p3stack", "on autonomous");
      for (const role of ["implementation", "review"]) {
        const assignment = { tools: [role === "review" ? "read" : "edit"] };
        const event = (task: string) => ({ toolName: delegation.terminal, input: { ...assignment, task } });
        const sample = event("Do it.");
        await h.emit("tool_call", sample);
        const header = sample.input.task.slice(0, -"Do it.".length);
        assert.match(header, role === "review" ? /report-only/ : /assigned unit|brief contract/);
        const body = "x".repeat(limit - header.length);
        const fits = event(body);
        assert.deepEqual(await h.results("tool_call", fits), []);
        assert.equal(fits.input.task, header + body);
        for (const excess of [1, header.length]) {
          const raw = body + "x".repeat(excess), over = event(raw);
          const [blocked] = await h.results("tool_call", over);
          assert.equal(blocked?.block, true);
          assert.match(blocked.reason, new RegExp(`shorten .* by ${excess} characters?\\b`, "i"));
          assert.equal(over.input.task, raw);
        }
      }
    } finally { h.dispose(); }
  });

  test(`${host} passes the tool result through without grading the brief by keywords`, async () => {
    const h = hostHarness(host);
    try {
      await h.command("p3stack", "on");
      for (const task of ["No interfaces yet. No acceptance criteria.", "Export parse(s: string): Row. Run npm test; 12 passed. Check the CLI output."]) {
        await h.emit("tool_call", { toolName: delegation[host], toolCallId: "dispatch", input: { task, tools: ["edit"] } });
        assert.deepEqual(await h.results("tool_result", { toolName: delegation[host], toolCallId: "dispatch", content: [{ type: "text", text: "spawned" }] }), []);
      }
    } finally { h.dispose(); }
  });
}

test("the TUI sets a footer while on and restores the stock footer while off or switching branches", async () => {
  const restore = asTerminal(), branch: unknown[] = [];
  const h = harness({ mode: "tui", branch });
  try {
    await h.emit("session_start");
    await h.emit("session_tree");
    await h.command("p3stack", "off");
    assert.deepEqual(h.footers, [], "do not clear another extension's footer");
    await h.command("p3stack", "on");
    assert.equal(typeof h.footers.at(-1), "function");
    await h.command("p3stack", "off");
    assert.equal(h.footers.at(-1), undefined);
    branch.push({ type: "custom", customType: "p3stack", data: { on: true } });
    await h.emit("session_tree");
    assert.equal(typeof h.footers.at(-1), "function");
    branch.length = 0;
    await h.emit("session_tree");
    assert.equal(h.footers.at(-1), undefined);
    assert.deepEqual(h.statuses, []);
  } finally { h.dispose(); restore(); }
});

test("non-TUI mode status follows toggles and the active branch, including under T3", async () => {
  for (const [host, mode] of [["terminal", "rpc"], ["t3", "rpc"], ["t3", "tui"]] as const) {
    const entry = { type: "custom", customType: "p3stack", data: { on: true, grant: "autonomous" } };
    const branch = [entry];
    const h = hostHarness(host, { mode, branch });
    try {
      await h.emit("session_start");
      await h.command("p3stack", "grant default");
      await h.command("p3stack", "off");
      await h.emit("session_tree");
      branch.length = 0;
      await h.emit("session_tree");
      await h.emit("session_start");
      assert.deepEqual(h.statuses, [
        ["p3stack", "p3stack · full-autonomy"], ["p3stack", "p3stack · default"], ["p3stack", undefined],
        ["p3stack", "p3stack · full-autonomy"], ["p3stack", undefined], ["p3stack", undefined],
      ]);
      assert.deepEqual(h.footers, []);
    } finally { h.dispose(); }
  }
});

test("the on footer prefixes the directory and matches Pi's stock rendering byte for byte", async () => {
  const restore = asTerminal(), h = harness({ mode: "tui" });
  const sessionManager = SessionManager.inMemory(h.cwd);
  const model: NonNullable<ExtensionContext["model"]> = { provider: "footer-fixture", id: "model-🅿️", name: "Footer fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1000 };
  const state = { model, thinkingLevel: "low" };
  try {
    initTheme("dark", false);
    const { theme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
    const contextUsage = { tokens: 23000, contextWindow: 272000, percent: 8.5 };
    const session = { model, state, sessionManager, getContextUsage: () => contextUsage, modelRuntime: { isUsingSubscription: () => false } };
    Object.assign(h.ctx, { model, thinkingLevel: state.thinkingLevel, sessionManager, getContextUsage: () => contextUsage });
    let branch: string | null = "p3stack/pr-04-mode-extension", renders = 0;
    let changed = () => {};
    const footerData = { getGitBranch: () => branch, getExtensionStatuses: () => new Map<string, string>(), getAvailableProviderCount: () => 2, onBranchChange: (callback: () => void) => { changed = callback; return () => { changed = () => {}; }; } };
    await h.command("p3stack", "on");
    const factory = h.footers.at(-1);
    assert.equal(typeof factory, "function");
    const tui = new TuiMainScreen(new ProcessTerminal());
    mock.method(tui, "requestRender", () => { renders++; });
    const footer = factory!(tui, theme, footerData);
    const reads = [mock.method(SettingsManager, "create"), mock.method(sessionManager, "getEntries"), mock.method(h.ctx, "getContextUsage"), mock.method(footerData, "getGitBranch")];
    for (let i = 0; i < 10; i++) { footer.invalidate(); footer.render(200); }
    assert.deepEqual(reads.map(read => read.mock.callCount()), [0, 0, 0, 0], "render does not load settings, scan the session or query git");
    // Stock consumes only the session data above; no agent or provider needs to run.
    const stock = new FooterComponent(session as unknown as ConstructorParameters<typeof FooterComponent>[0], footerData);
    const prefix = "🅿️ ";
    assert.equal(footer.render(200)[0], prefix + stock.render(200)[0]);
    for (const percent of [0, 75, 95, null]) {
      Object.assign(contextUsage, { percent });
      for (const enabled of [true, false]) {
        writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({ compaction: { enabled } }));
        await h.emit("before_agent_start");
        stock.setAutoCompactEnabled(enabled);
        for (const width of [200, 100, 40, 10, 3, 1]) {
          footer.invalidate();
          const actual = footer.render(width), expected = stock.render(width);
          assert.equal(actual.length, 2);
          assert.equal(actual[1], expected[1], `stock stats at width ${width}, context ${percent}, auto ${enabled}`);
          assert.ok(actual.every(line => visibleWidth(line) <= width));
          if (width === 200) assert.equal(actual[0], prefix + expected[0]);
          else assert.equal(actual[0], truncateToWidth(prefix + stock.render(1000)[0]!, width, theme.fg("dim", "...")));
        }
      }
    }
    sessionManager.appendSessionInfo("named session");
    await h.emit("session_info_changed");
    branch = null;
    const beforeBranch = renders;
    changed();
    assert.equal(renders, beforeBranch + 1);
    assert.equal(footer.render(200)[0], prefix + stock.render(200)[0]);
    sessionManager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: { input: 1234, output: 56, cacheRead: 3000, cacheWrite: 400, totalTokens: 4690, cost: { input: 0.1, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.19 } }, stopReason: "stop", timestamp: Date.now() });
    await h.emit("turn_end");
    assert.equal(footer.render(200)[1], stock.render(200)[1]);
    model.provider = "kimi-coding";
    await h.emit("model_select");
    assert.equal(footer.render(200)[1], stock.render(200)[1]);
    assert.match(stripTerminalSequences(footer.render(200)[1]!), /\$0\.190 \(sub\)/);
    model.reasoning = false;
    await h.emit("model_select");
    assert.equal(footer.render(200)[1], stock.render(200)[1]);
    Object.assign(h.ctx, { thinkingLevel: "off" });
    state.thinkingLevel = "off";
    model.reasoning = true;
    await h.emit("thinking_level_select");
    assert.equal(footer.render(200)[1], stock.render(200)[1]);
    footer.dispose?.(); // Another extension took over the footer.
    const afterDispose = renders;
    changed();
    assert.equal(renders, afterDispose);
    await h.command("p3stack", "off");
    assert.deepEqual(h.footers, [factory], "a disposed footer is no longer ours to clear");
  } finally { h.dispose(); restore(); mock.restoreAll(); }
});

test("terminal briefs keep the local writer contract or report-only review stance", async () => {
  const h = hostHarness("terminal");
  try {
    await h.command("p3stack", "on autonomous");
    for (const tools of [["read", "bash"], ["read", "edit"], ["write"], ["subagent_spawn"]]) {
      const task = (await h.emit("tool_call", { toolName: delegation.terminal, input: { tools, task: "Inspect it." } })).input.task;
      assert.match(task, /Grant: full-autonomy\./);
      if (tools.includes("bash")) {
        assert.match(task, /report-only delegate/);
        assert.match(task, /Do not read the poteto-mode skill, start a playbook, or delegate/);
        assert.match(task, /author's conclusions are not evidence/);
        assert.match(task, /measured, inferred, or guess/);
        assert.match(task, /review-stance\.md/);
        assert.doesNotMatch(task, /poteto-agent\.md|read-only delegate|input to your parent's decision/);
      } else {
        assert.match(task, /read .*agents\/poteto-agent\.md/);
        assert.match(task, /brief-contract\.md/);
        assert.match(task, /done predicate/);
        assert.match(task, /Do not spawn your own reviewer/);
      }
    }
  } finally { h.dispose(); }
});

test("T3 dispatch never changes the task after supervised approval, including inside codemode", async () => {
  const h = hostHarness("t3", { t3: { providers: [] } });
  try {
    await h.command("p3stack", "on autonomous");
    const event = { type: "tool_call", toolName: delegation.t3, toolCallId: "cm/1", parentToolCallId: "cm",
      input: { role: "review", task: "Task grant: default\nInspect the importer; send findings only." } };
    async function dispatch() {
      const approved = structuredClone(event.input); // The bridge's tool_call handler runs first.
      const blocked = (await h.results("tool_call", event)).find(result => result.block);
      if (blocked) return false;
      assert.deepEqual(event.input, approved, "the bridge must transport exactly what it approved");
      return true;
    }
    assert.equal(await dispatch(), false, "decline an unprepared task instead of rewriting it");
    const { briefHeaders } = (await h.call("p3stack_roles", {})).structuredContent;
    event.input.task = briefHeaders.report.replace("Grant: full-autonomy.", "Task grant: default") + "\n\nInspect the importer; send findings only.";
    assert.equal(await dispatch(), true);
    assert.doesNotMatch(event.input.task, /full-autonomy/);
    assert.match(event.input.task, /Task grant: default\b/);
    event.input.task = briefHeaders.report + "\n\nTask grant: default\nInspect the importer.";
    assert.equal(await dispatch(), false, "two grant lines cannot reach the child");
    for (const line of ["  Task grant: default", "task grant: full-autonomy", "- **Task grant:** default", "> GRANT: default"]) {
      event.input.task = briefHeaders.report + `\n\nInspect the importer.\n${line}`;
      assert.equal(await dispatch(), false, `a body grant line in another form is refused: ${line}`);
    }
    event.input.task = briefHeaders.report + "\n\nInspect the importer; the grant: field in config.ts is unrelated.";
    assert.equal(await dispatch(), true, "prose that mentions a grant mid-line passes");
    await h.command("p3stack", "grant default");
    event.input.task = briefHeaders.report + "\n\nInspect the importer.";
    assert.equal(await dispatch(), false, "a saved session grant goes stale");
    event.input.task = event.input.task.replace("Grant: full-autonomy.", "Task grant: full-autonomy");
    assert.equal(await dispatch(), true, "an explicit task-only raise travels alone");
  } finally { h.dispose(); }
});

test("supervised T3 calls beyond the approval preview put task last and send the brief whole", async t => {
  const prev = process.env.T3_PI_RUNTIME_MODE;
  t.after(() => { if (prev === undefined) delete process.env.T3_PI_RUNTIME_MODE; else process.env.T3_PI_RUNTIME_MODE = prev; });
  const h = hostHarness("t3", { t3: { providers: [] } });
  try {
    await h.command("p3stack", "on");
    const { work } = (await h.call("p3stack_roles", {})).structuredContent.briefHeaders;
    const dispatch = (input: object) => h.results("tool_call", { toolName: delegation.t3, input });
    const args = { role: "implementation", isolation: "worktree", target: { model: "example" } };
    const base = work + "\n\nInspect the importer.";
    const fits = { task: base + "x".repeat(4000 - JSON.stringify({ task: base, ...args }, null, 2).length), ...args };
    const task = fits.task + "x";
    for (const mode of ["auto", "approval-required", "auto-accept-edits"]) {
      process.env.T3_PI_RUNTIME_MODE = mode;
      assert.deepEqual(await dispatch(fits), [], "at 4,000 characters the whole call is visible");
      const [blocked] = await dispatch({ task, ...args });
      assert.equal(blocked?.block, true, mode);
      assert.match(blocked.reason, /put task last/i);
      const ordered = { ...args, task: task + "y".repeat(5000) };
      const sent = structuredClone(ordered);
      assert.deepEqual(await dispatch(ordered), [], mode);
      assert.deepEqual(ordered, sent);
    }
    process.env.T3_PI_RUNTIME_MODE = "full-access";
    assert.deepEqual(await dispatch({ task, ...args }), []);
  } finally { h.dispose(); }
});

test("T3 briefs are self-contained for every role", async () => {
  const h = hostHarness("t3");
  try {
    await h.command("p3stack", "on autonomous");
    const { briefHeaders: headers } = (await h.call("p3stack_roles", {})).structuredContent;
    for (const role of ["research", "review", "implementation", "design", "test", "general", undefined]) {
      const prefix = headers[role === "review" || role === "research" ? "report" : "work"] + "\n\n";
      const task = prefix + "Inspect the change.";
      const dispatch = (task: string) => h.results("tool_call", { toolName: delegation.t3, input: { role, task } });
      assert.deepEqual(await dispatch(task), []);
      const limit = prefix + "x".repeat(120_000 - prefix.length);
      assert.deepEqual(await dispatch(limit), []);
      assert.match((await dispatch(limit + "x"))[0].reason, /shorten .* by 1 character/i);
      assert.match(task, /Grant: full-autonomy\./);
      assert.doesNotMatch(task, /Task grant:/);
      assert.doesNotMatch(task, /poteto|SKILL\.md|\.md\b|read-only|\/[^< ]+\//);
      if (role === "research" || role === "review") {
        assert.match(task, /report-only/i);
        assert.match(task, /contract.*author's summary/i);
        assert.match(task, /measured, inferred, or guess/);
        assert.match(task, /file:line/);
      } else {
        assert.match(task, /assigned unit and the procedures this brief assigns/i);
        assert.match(task, /no other playbook and no reviewer of your own/i);
        assert.match(task, /assumptions.*brief is silent/i);
        assert.match(task, /evidence for each claim/i);
      }
    }
  } finally { h.dispose(); }
});

test("doctor is neither advertised nor run in a terminal", async () => {
  const h = hostHarness("terminal");
  try {
    await h.command("p3stack", "doctor");
    assert.equal(existsSync(join(h.agentDir, "p3stack", "t3-contract.json")), false);
    assert.match(h.notices.at(-1)![0], /not launched by T3 Code/i);
    assert.doesNotMatch(h.commands.get("p3stack").description, /doctor|T3/i);
    await h.command("p3stack", "help");
    assert.doesNotMatch(h.notices.at(-1)![0], /doctor|T3/i);
  } finally { h.dispose(); }
});

test("doctor records the T3 inventory without an installed bridge fingerprint", async () => {
  const h = hostHarness("t3", { extraTools: [
    { name: "mcp__t3-code__delegate_task", exposure: "direct" },
    { name: "mcp__t3-code__hidden", exposure: "hidden" },
    { name: "mcp__other__tool", exposure: "codemode" },
  ] });
  const file = join(h.agentDir, "p3stack", "t3-contract.json");
  try {
    assert.match(h.commands.get("p3stack").description, /doctor/);
    await h.command("p3stack", "doctor extra");
    assert.match(h.notices.at(-1)![0], /^Usage: .*doctor/);
    assert.equal(existsSync(file), false);
    await h.command("p3stack", "doctor");
    const report = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(report.tools, [{ name: "mcp__t3-code__delegate_task", exposure: "direct" }, { name: "mcp__t3-code__hidden", exposure: "hidden" }]);
    assert.equal("claudeSubscriptionBeforeBridge" in report, false);
    assert.deepEqual(report.problems, [], "claude-subscription is optional");
  } finally { h.dispose(); }
});


test("doctor matches real provider paths and flags only multiple distinct copies", async () => {
  const commands: LoadedCommand[] = [];
  const h = hostHarness("t3", { commands });
  const file = (install: string) => {
    const path = join(h.root, install, "packages/claude-subscription/extensions/claude-subscription/index.ts");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export default function() {}\n");
    return path;
  };
  const checkout = file("checkout"), clone = file("clone"), linked = join(h.root, "linked.ts");
  symlinkSync(checkout, linked);
  const loaded = (path: string, name = "claude-subscription") => ({ name, source: "extension", sourceInfo: { path } });
  try {
    for (const [registered, files, flagged] of [
      [[loaded(checkout), loaded(checkout, "claude-login"), loaded(join(h.root, "web-search/index.ts"), "search")], [checkout], false],
      [[loaded(checkout), loaded(clone)], [checkout, clone], true],
      [[loaded(linked)], [checkout], false],
      [[loaded(checkout), loaded(linked)], [checkout], false],
      [[{ ...loaded(checkout), source: "prompt" }], [], false],
    ] as [LoadedCommand[], string[], boolean][]) {
      commands.splice(0, commands.length, ...registered);
      await h.command("p3stack", "doctor");
      const report = JSON.parse(readFileSync(join(h.agentDir, "p3stack", "t3-contract.json"), "utf8"));
      assert.deepEqual(report.claudeSubscriptionFiles, files);
      assert.equal(report.problems.some((problem: string) => problem.startsWith(`claude-subscription loaded from ${files.length} files`)), flagged, report.problems.join("\n"));
    }
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

test("ask_user distinguishes a literal Other option from a free-text invitation", async () => {
  const label = "Other (type an answer)";
  const h = harness({ answers: [label, label, "custom choice"] });
  try {
    assert.equal(text(await h.call("ask_user", { question: "Which?", options: [label] })), `The human chose: ${label}`);
    assert.deepEqual(h.asked, [`Which? [${label}]`]);
    assert.equal(text(await h.call("ask_user", { question: "Which?", options: [label], allowOther: true })), "The human answered: custom choice");
    assert.deepEqual(h.asked.slice(1), [`Which? [${label}]`, "Which?"]);
  } finally { h.dispose(); }
});

test("ask_user never treats an unanswered question without a default as approval", async () => {
  for (const hasUI of [false, true]) {
    const h = harness({ hasUI });
    try {
      const answer = text(await h.call("ask_user", { question: "Which?" }));
      assert.match(answer, /do not treat silence as approval/i);
      assert.match(answer, /take the option that changes least, or stop and say what is needed/i);
    } finally { h.dispose(); }
  }
});

test("ask_user sends the tool's abort signal to every dialog and propagates cancellation", async () => {
  const h = harness();
  try {
    for (const kind of ["select", "input", "other"]) {
      const controller = new AbortController(), seen: string[] = [];
      const dialog = (method: string, opts?: { signal?: AbortSignal }) => {
        assert.equal(opts?.signal, controller.signal);
        seen.push(method);
        if (method === "select" && kind === "other") return "Other (type an answer)";
        controller.abort();
        return undefined; // Pi resolves a cancelled dialog without an answer.
      };
      const ui = {
        select: async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => dialog("select", opts),
        input: async (_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => dialog("input", opts),
      };
      const args = { question: "Which?", options: kind === "input" ? undefined : ["one"], allowOther: kind === "other", default: "one" };
      await assert.rejects(h.tools.get("ask_user").execute("call", args, controller.signal, undefined, { ...h.ctx, ui }), { name: "AbortError" });
      assert.deepEqual(seen, kind === "other" ? ["select", "input"] : [kind]);
    }
  } finally { h.dispose(); }
});

function asHost(host: "cli" | "t3") {
  const previous = process.env.T3_MCP_URL;
  if (host === "cli") delete process.env.T3_MCP_URL; else process.env.T3_MCP_URL = "http://127.0.0.1:1/mcp";
  return () => { if (previous === undefined) delete process.env.T3_MCP_URL; else process.env.T3_MCP_URL = previous; };
}
const asTerminal = () => asHost("cli");

test("/p3stack-setup maps a budget and two models onto every role and writes the file", async () => {
  const restore = asTerminal();
  const h = harness({ answers: ["unlimited, max thinking", "xai/grok-4.7:xhigh", "claude/claude-opus-5-5:max"] });
  try {
    await h.command("p3stack-setup");
    const written = JSON.parse(readFileSync(join(h.agentDir, "p3stack.json"), "utf8"));
    assert.equal(written.budget, "unlimited (max)");
    assert.equal(written.roles["swarm workers"], "xai/grok-4.7:xhigh");
    assert.equal(written.roles["judgment and prose"], "claude/claude-opus-5-5:max");
    assert.deepEqual(written.roles["interrogate reviewers"], ["claude/claude-opus-5-5:max", "xai/grok-4.7:xhigh"]);
    assert.match(h.notices.at(-1)![0], /Wrote .*p3stack\.json/);
  } finally { h.dispose(); restore(); }
});

test("/p3stack-setup keeps review and prose roles at high thinking or above on the small budget", async () => {
  const restore = asTerminal();
  const h = harness({ answers: ["small, medium thinking", "xai/grok-4.7:medium", "claude/claude-opus-5-5:high"] });
  try {
    await h.command("p3stack-setup");
    const written = JSON.parse(readFileSync(join(h.agentDir, "p3stack.json"), "utf8"));
    assert.equal(written.roles["swarm workers"], "xai/grok-4.7:medium");
    assert.equal(written.roles["interrogate reviewers"][0], "claude/claude-opus-5-5:high");
    assert.match(h.asked.find(question => question.startsWith("Model for judgment"))!, /claude-opus-5-5:high/);
    assert.match(h.notices.at(-1)![0], /Judgment roles: claude\/claude-opus-5-5:high/);
  } finally { h.dispose(); restore(); }
});

test("/p3stack-setup needs a T3 catalog receipt and never prompts without UI", async t => {
  t.after(asHost("t3"));
  const h = harness();
  try {
    await h.command("p3stack-setup");
    assert.match(h.notices.at(-1)![0], /No T3 catalog.*p3stack_roles.*rerun \/p3stack-setup/s);
    assert.deepEqual(h.asked, []);
  } finally { h.dispose(); }
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

test("a terminal coordinator's grant lines count in any case, indent or markup", async () => {
  const previous = process.env.T3_MCP_URL;
  delete process.env.T3_MCP_URL;
  try {
    const { registerBrief } = await import("../extensions/p3stack/src/brief.ts");
    let prepare: (data: unknown) => void = () => {};
    const handlers = new Map<string, Function>();
    const pi = { on: (name: string, handler: Function) => handlers.set(name, handler), events: { on: (_: string, h: typeof prepare) => { prepare = h; return () => {}; } } };
    registerBrief(pi as never, Object.assign(() => true, { grant: () => "autonomous" as const }), "router.md", "agent.md");
    handlers.get("session_start")!();
    const parent = (body: string) => `<p3stack-brief>Grant: full-autonomy.\nstance\n</p3stack-brief>\n\n${body}`;
    for (const line of ["  task grant: default", "- **Task grant:** default", "TASK GRANT: default."]) {
      const req = { task: "Inspect.", tools: ["read"], parentTask: parent(`Coordinate.\n${line}`) } as { task: string; tools: string[]; parentTask: string; error?: string };
      prepare(req);
      assert.equal(req.error, undefined);
      assert.match(req.task, /^<p3stack-brief>Grant: default\./, `lowered by: ${line}`);
      const raise = { task: "Inspect.\n  task grant: full-autonomy", tools: ["read"], parentTask: req.parentTask } as typeof req;
      prepare(raise);
      assert.match(raise.error ?? "", /cannot raise/, `raise refused after: ${line}`);
    }
  } finally { if (previous === undefined) delete process.env.T3_MCP_URL; else process.env.T3_MCP_URL = previous; }
});
