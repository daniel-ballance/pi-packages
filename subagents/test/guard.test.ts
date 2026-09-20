import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuard from "../src/child-guard.js";
import subagents from "../index.js";

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

test("management extension registers nothing inside a marked child", () => {
  const old = process.env.PI_SUBAGENT;
  process.env.PI_SUBAGENT = "1";
  try { subagents(new Proxy({}, { get() { throw new Error("Child attempted to register manager API"); } }) as ExtensionAPI); }
  finally { if (old === undefined) delete process.env.PI_SUBAGENT; else process.env.PI_SUBAGENT = old; }
});

test("agent-facing spawn schema has no raw argument, executable or environment escape hatch", () => {
  const tools: any[] = [];
  subagents({ on() {}, registerCommand() {}, registerTool(tool: unknown) { tools.push(tool); } } as unknown as ExtensionAPI);
  const schema = tools.find(t => t.name === "subagent_spawn").parameters;
  for (const key of ["cliArgs", "executable", "executableArgs", "env", "inheritExtensions", "thinking"]) assert.equal(schema.properties[key], undefined);
  assert.ok(schema.required.includes("model"));
  assert.ok(schema.required.includes("tools"));
  assert.ok(tools.some(t => t.name === "subagent_catalog"));
});
