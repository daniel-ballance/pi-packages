import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { asHost } from "./host-env.js";

const guidance = "The limit of 1 counts every live child in the whole tree (1 live); you can only close your own idle children, and if you have none to reuse or close, do not retry, and if you have a way to message your parent, ask for a slot, otherwise report the limit in your final reply.";

test("a nested spawn at the live cap is told not to retry, and a root spawn is not", { timeout: 20000, skip: process.platform === "win32" }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "capacity-guidance-")));
  const repo = join(root, "repo"), agentDir = join(root, "agent"), bin = join(root, "bin");
  mkdirSync(repo); mkdirSync(agentDir); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "pi.mjs"))} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(root, "pi.mjs"), readFileSync(new URL("./fixtures/compact-spawn-pi.mjs", import.meta.url)));
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({
    version: 1, models: [{ id: "p/m:off" }], tools: ["subagent_spawn"], maxDepth: 2, maxChildren: 1, workingDirectories: ["."],
  }));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.SPAWN_ON = "please-spawn";
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: { id: string } }> }>();
  const handlers = new Map<string, Function[]>();
  const ctx = {
    cwd: repo, mode: "rpc", hasUI: false, isIdle: () => true, isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "m", input: ["text"], contextWindow: 1000, maxTokens: 100, cost: {}, reasoning: false }] },
    ui: { notify() {}, setStatus() {} }, sessionManager: { getEntries: () => [], getSessionId: () => "s", getSessionFile: () => join(root, "s.jsonl") },
  };
  const messageOf = (thrown: unknown) => thrown instanceof Error ? thrown.message : String(thrown);
  try {
    asHost("cli", () => {
      subagents({
        registerFlag() {}, getFlag() { return false; },
        on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
        registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); }, registerCommand() {}, sendMessage() {},
        getAllTools: () => [], events: { on: () => () => {} },
      } as unknown as ExtensionAPI);
      for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
    });
    const spawn = (name: string, task: string, toolsSelected: string[]) => tools.get("subagent_spawn")!.execute("c", {
      name, task, cwd: repo, model: "p/m:off", tools: toolsSelected,
    }, undefined, undefined, ctx);
    const coordinator = await spawn("coordinator", "stay", ["subagent_spawn"]);
    await assert.rejects(spawn("root-extra", "again", []), (thrown: unknown) => {
      const message = messageOf(thrown);
      assert.match(message, /Live-child capacity reached \(limit 1\)\. Inspect before closing idle workers; held work requires discussion\. Recovery:/);
      assert.doesNotMatch(message, /message your parent/);
      assert.doesNotMatch(message, /whole tree/);
      return true;
    });
    await assert.rejects(
      tools.get("subagent_send")!.execute("c", { id: coordinator.details.id, message: "please-spawn" }, undefined, undefined, ctx),
      (thrown: unknown) => {
        const message = messageOf(thrown);
        assert.match(message, /Live-child capacity reached \(limit 1\)\. Inspect before closing idle workers/);
        assert.ok(message.includes(guidance), message);
        return true;
      },
    );
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    process.env.PATH = previousPath;
    delete process.env.SPAWN_ON;
    rmSync(root, { recursive: true, force: true });
  }
});
