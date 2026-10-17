import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { subagentRenderers } from "../extensions/subagents/src/render.js";
import { asHost } from "./host-env.js";

const marker = "TASK-MARKER-9f3a";
const task = `${marker}\n${"x".repeat(2048)}`.slice(0, 2048);
const banned = ["task", "sessionFile", "logFile", "stderrFile", "usage", "cwd", "config", "updates", "assignment"];

function keys(value: unknown): string[] {
  return Object.keys(JSON.parse(JSON.stringify(value))).sort();
}

async function withSpawn(run: (spawn: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>, repo: string, root: string) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "compact-spawn-")));
  const repo = join(root, "repo"), agentDir = join(root, "agent"), bin = join(root, "bin");
  mkdirSync(repo); mkdirSync(agentDir); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "compact-spawn-pi.mjs"))} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(root, "compact-spawn-pi.mjs"), readFileSync(new URL("./fixtures/compact-spawn-pi.mjs", import.meta.url)));
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({
    version: 1, models: [{ id: "p/m:off" }], tools: ["subagent_spawn"], maxDepth: 2, workingDirectories: ["."],
  }));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> }>();
  const handlers = new Map<string, Function[]>();
  const ctx = {
    cwd: repo, mode: "rpc", hasUI: false, isIdle: () => true, isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "m", input: ["text"], contextWindow: 1000, maxTokens: 100, cost: {}, reasoning: false }] },
    ui: { notify() {}, setStatus() {} }, sessionManager: { getEntries: () => [], getSessionId: () => "s", getSessionFile: () => join(root, "s.jsonl") },
  };
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
    await run((args) => tools.get("subagent_spawn")!.execute("c", args, undefined, undefined, ctx), repo, root);
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    process.env.PATH = previousPath;
    delete process.env.SPAWN_PROOF;
    delete process.env.SPAWN_TASK_FILE;
    rmSync(root, { recursive: true, force: true });
  }
}

test("a spawn with a 2KB task returns neither the task nor sessionFile, under 1KB, and the card still shows name, state and model", { timeout: 20000, skip: process.platform === "win32" }, async () => {
  assert.equal(Buffer.byteLength(task), 2048);
  await withSpawn(async (spawn, repo) => {
    const result = await spawn({ name: "size-probe", task, cwd: repo, model: "p/m:off", tools: [] });
    const text = result.content.map(part => part.text).join("\n");
    assert.equal(text.includes(marker), false, text);
    assert.equal(text.includes("sessionFile"), false, text);
    assert.ok(Buffer.byteLength(text) < 1024, String(Buffer.byteLength(text)));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024, String(Buffer.byteLength(JSON.stringify(result))));
    for (const key of banned) assert.equal(key in result.details, false, key);
    assert.equal(result.details.model, "p/m");
    assert.equal(result.details.thinking, "off");
    assert.deepEqual(result.details.coordinationWarnings, []);
    assert.equal(result.details.coordinationWarningCount, 0);
    const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as Theme;
    const rendered = subagentRenderers("spawn").renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false, args: { name: "size-probe", task, model: "p/m:off" } } as never).render(120).join("\n");
    assert.match(rendered, /size-probe/);
    assert.match(rendered, /working/);
    assert.match(rendered, /m · off/);
    assert.equal(rendered.includes("x".repeat(100)), false);
  });
});

test("a proxied spawn returns the same compact entry", { timeout: 20000, skip: process.platform === "win32" }, async () => {
  await withSpawn(async (spawn, repo, root) => {
    const proof = join(root, "proof.json");
    writeFileSync(join(root, "task.txt"), task);
    process.env.SPAWN_PROOF = proof;
    process.env.SPAWN_TASK_FILE = join(root, "task.txt");
    const direct = await spawn({ name: "size-probe", task, cwd: repo, model: "p/m:off", tools: [] });
    const coordinator = await spawn({ name: "coordinator", task: "delegate", cwd: repo, model: "p/m:off", tools: ["subagent_spawn"] });
    const proxied = JSON.parse(readFileSync(proof, "utf8")) as Record<string, unknown>;
    const proxiedText = JSON.stringify(proxied, null, 2);
    assert.equal(proxiedText.includes(marker), false, proxiedText);
    assert.equal(proxiedText.includes("sessionFile"), false, proxiedText);
    assert.ok(Buffer.byteLength(proxiedText) < 1024, String(Buffer.byteLength(proxiedText)));
    for (const key of banned) assert.equal(key in proxied, false, key);
    assert.deepEqual(proxied.coordinationWarnings, []);
    assert.equal(proxied.coordinationWarningCount, 0);
    assert.equal(proxied.parentId, coordinator.details.id);
    assert.equal(proxied.depth, 2);
    assert.equal(proxied.name, "worker");
    assert.equal(proxied.status, direct.details.status);
    assert.equal(proxied.model, direct.details.model);
    assert.equal(proxied.thinking, direct.details.thinking);
    assert.deepEqual(keys(proxied).filter(key => key !== "depth" && key !== "parentId"), keys(direct.details).filter(key => key !== "depth" && key !== "parentId"));
  });
});
