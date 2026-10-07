import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";

test("parsed opt-out prevents all native initialization, not just tool exposure", () => {
  const hooks = new Map<string, Function[]>();
  const tools: unknown[] = [], commands: string[] = [], flags: string[] = [];
  let disabled = false; // CLI flag values arrive after the factory runs.
  subagents({
    registerFlag(name: string) { flags.push(name); },
    getFlag() { return disabled; },
    on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
    registerTool(tool: unknown) { tools.push(tool); },
    registerCommand(name: string) { commands.push(name); },
  } as unknown as ExtensionAPI);
  assert.deepEqual(flags, ["disable-native-subagents"]);
  disabled = true;
  const context = new Proxy({}, { get() { throw new Error("Disabled extension touched session state"); } });
  for (const handler of hooks.get("session_start") ?? []) handler({}, context);
  assert.deepEqual(tools, []);
  assert.deepEqual(commands, []);
  assert.deepEqual([...hooks.keys()], ["session_start"]); // No notifications, workflow or shutdown hooks.
});

test("unflagged startup registers the existing tools once", () => {
  const hooks = new Map<string, Function[]>();
  const tools: string[] = [], commands: string[] = [];
  subagents({
    registerFlag() {}, getFlag() { return false; },
    on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
  } as unknown as ExtensionAPI);
  const start = hooks.get("session_start")![0];
  const ctx = { mode: "print" } as ExtensionContext;
  start({}, ctx); start({}, ctx);
  assert.equal(tools.length, 18);
  assert.ok(tools.includes("subagent_spawn"));
  assert.ok(tools.includes("subagent_workflow_start"));
  assert.ok(commands.includes("subagents"));
  assert.ok(hooks.has("session_shutdown"));
});
