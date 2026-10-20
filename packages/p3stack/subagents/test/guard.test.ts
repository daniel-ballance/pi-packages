import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import childGuard from "../extensions/subagents/src/child-guard.js";
import subagents from "../extensions/subagents/index.js";
import { nativeTools } from "./native-tools.js";

test("child guard hides recursive and unselected tools and blocks later reactivation", () => {
  const old = process.env.PI_SUBAGENT_ALLOWED_TOOLS;
  process.env.PI_SUBAGENT_ALLOWED_TOOLS = JSON.stringify(["read", "subagent_spawn"]);
  let active = ["read", "bash", "subagent_spawn", "subagent_other"];
  const hooks = new Map<string, Function>();
  try {
    childGuard({
      on: (name: string, fn: Function) => hooks.set(name, fn),
      registerCommand: () => {},
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; },
    } as unknown as ExtensionAPI);
    hooks.get("session_start")!();
    assert.deepEqual(active, ["read"]);
    assert.equal(hooks.get("tool_call")!({ toolName: "subagent_spawn" }).block, true);
    assert.equal(hooks.get("tool_call")!({ toolName: "bash" }).block, true);
    assert.equal(hooks.get("tool_call")!({ toolName: "read" }), undefined);
    active.push("subagent_spawn");
    hooks.get("before_agent_start")!();
    assert.deepEqual(active, ["read"]);
  } finally {
    if (old === undefined) delete process.env.PI_SUBAGENT_ALLOWED_TOOLS;
    else process.env.PI_SUBAGENT_ALLOWED_TOOLS = old;
  }
});

test("peer send call row names the recipient and previews the message", () => {
  const oldTools = process.env.PI_SUBAGENT_ALLOWED_TOOLS;
  const oldFd = process.env.PI_SUBAGENT_PEER_FD;
  process.env.PI_SUBAGENT_ALLOWED_TOOLS = JSON.stringify(["peer_send"]);
  process.env.PI_SUBAGENT_PEER_FD = "3";
  const tools = new Map<string, { name: string; renderCall?: Function }>();
  try {
    childGuard({
      on() {}, registerCommand() {},
      registerTool(tool: { name: string; renderCall?: Function }) { tools.set(tool.name, tool); },
      getActiveTools: () => [], setActiveTools() {},
    } as unknown as ExtensionAPI);
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
    const line = tools.get("peer_send")!.renderCall!({ recipient: "reviewer", message: "Remember kiwi" }, theme, { argsComplete: true }).render(80)[0];
    assert.equal(line.trimEnd(), "reviewer • send Remember kiwi");
  } finally {
    if (oldTools === undefined) delete process.env.PI_SUBAGENT_ALLOWED_TOOLS;
    else process.env.PI_SUBAGENT_ALLOWED_TOOLS = oldTools;
    if (oldFd === undefined) delete process.env.PI_SUBAGENT_PEER_FD;
    else process.env.PI_SUBAGENT_PEER_FD = oldFd;
  }
});

test("managed source checks reject replacement tools and suppress inherited warming", () => {
  const saved = { policy: process.env.PI_SUBAGENT_POLICY, tools: process.env.PI_SUBAGENT_ALLOWED_TOOLS };
  process.env.PI_SUBAGENT_ALLOWED_TOOLS = JSON.stringify(["read"]);
  process.env.PI_SUBAGENT_POLICY = JSON.stringify({ version: 1, builtins: [], toolSources: { read: "builtin:read" },
    model: "test/stub:off", settings: { cacheWarming: "off" }, mcp: { servers: [], inheritCredentials: false }, agentDir: "/unused", projectTrusted: false });
  const hooks = new Map<string, Function>();
  let source = "builtin:read";
  try {
    childGuard({
      on: (name: string, fn: Function) => hooks.set(name, fn), registerCommand() {},
      getActiveTools: () => ["read"], setActiveTools() {},
      getAllTools: () => [{ name: "read", exposure: "direct", sourceInfo: { path: source } }],
    } as unknown as ExtensionAPI);
    assert.deepEqual(hooks.get("cache_warming_decision")!({ action: "warm" }), { action: "stop" });
    const ctx = { model: { provider: "test", id: "stub", api: "test" } };
    assert.equal(hooks.get("tool_call")!({ toolName: "read" }, ctx), undefined);
    source = "/unselected/override.ts";
    assert.equal(hooks.get("tool_call")!({ toolName: "read" }, ctx).block, true);
    source = "builtin:read";
    assert.equal(hooks.get("tool_call")!({ toolName: "read" }, { model: { ...ctx.model, api: "pi-virtual" } }).block, true);
    assert.equal(hooks.get("tool_call")!({ toolName: "read" }, { model: { ...ctx.model, id: "different" } }).block, true);
  } finally {
    if (saved.policy === undefined) delete process.env.PI_SUBAGENT_POLICY; else process.env.PI_SUBAGENT_POLICY = saved.policy;
    if (saved.tools === undefined) delete process.env.PI_SUBAGENT_ALLOWED_TOOLS; else process.env.PI_SUBAGENT_ALLOWED_TOOLS = saved.tools;
  }
});

test("management extension registers nothing inside a marked child", () => {
  const old = process.env.PI_SUBAGENT;
  process.env.PI_SUBAGENT = "1";
  try { subagents(new Proxy({}, { get() { throw new Error("Child attempted to register manager API"); } }) as ExtensionAPI); }
  finally { if (old === undefined) delete process.env.PI_SUBAGENT; else process.env.PI_SUBAGENT = old; }
});

test("agent-facing spawn schema has no raw argument, executable or environment escape hatch", () => {
  const tools: any[] = nativeTools();
  const schema = tools.find(t => t.name === "subagent_spawn").parameters;
  for (const key of ["cliArgs", "executable", "executableArgs", "env", "inheritExtensions", "thinking"]) assert.equal(schema.properties[key], undefined);
  assert.ok(schema.required.includes("model"));
  assert.ok(schema.required.includes("tools"));
  assert.ok(tools.some(t => t.name === "subagent_catalog"));
});
