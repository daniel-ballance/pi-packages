import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { asHost } from "./host-env.js";

test("parsed opt-out prevents all native initialization, not just tool exposure", () => asHost("cli", () => {
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
  assert.deepEqual([...hooks.keys()].filter(name => name !== "resources_discover"), ["session_start"]); // No manager hooks.
}));

test("a T3-launched session prevents native initialization without the flag", () => {
  asHost("t3", () => {
    const hooks = new Map<string, Function[]>();
    const tools: unknown[] = [], commands: string[] = [], flags: string[] = [];
    subagents({
      registerFlag(name: string) { flags.push(name); }, getFlag() { return false; },
      on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
      registerTool(tool: unknown) { tools.push(tool); },
      registerCommand(name: string) { commands.push(name); },
    } as unknown as ExtensionAPI);
    const context = new Proxy({}, { get() { throw new Error("Disabled extension touched session state"); } });
    for (const handler of hooks.get("session_start") ?? []) handler({}, context);
    assert.deepEqual(tools, []);
    assert.deepEqual(commands, []);
    assert.deepEqual([...hooks.keys()], []);
    assert.deepEqual(flags, ["disable-native-subagents"]);
  });
});

for (const mode of ["print", "json"]) test(`${mode} mode exposes no native tools, commands or skills`, () => asHost("cli", () => {
  const hooks = new Map<string, Function[]>();
  const tools: string[] = [], commands: string[] = [];
  subagents({
    registerFlag() {}, getFlag() { return false; },
    on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
    events: { on: () => () => {} },
  } as unknown as ExtensionAPI);
  const start = hooks.get("session_start")![0];
  const ctx = { mode } as ExtensionContext;
  start({}, ctx); start({}, ctx);
  for (const discover of hooks.get("resources_discover") ?? []) assert.deepEqual(discover({}, ctx)?.skillPaths ?? [], []);
  assert.deepEqual(tools, []);
  assert.deepEqual(commands, []);
}));
