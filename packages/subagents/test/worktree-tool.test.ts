import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { asHost } from "./host-env.js";

test("a worktree outside workingDirectories is refused and leaves no checkout or branch behind", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-tool-"))), repo = join(root, "repo"), agentDir = join(root, "agent");
  mkdirSync(join(repo, "src"), { recursive: true }); mkdirSync(agentDir);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "src/a.ts"), "1\n");
  git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  // The model and tools are allowed; only the new checkout's location is not.
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "p/m:off" }], tools: [], workingDirectories: ["./src"] }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const tools = new Map<string, any>(), handlers = new Map<string, Function[]>();
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
        registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, sendMessage() {},
        getAllTools: () => [], events: { on: () => () => {} },
      } as unknown as ExtensionAPI);
      for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
    });
    await assert.rejects(
      tools.get("subagent_spawn").execute("c", { name: "outside", task: "x", cwd: join(repo, "src"), model: "p/m:off", tools: [], worktree: true }, undefined, undefined, ctx),
      /outside allowed workingDirectories/);
    assert.equal(git("worktree", "list").split("\n").length, 1, "no worktree left behind");
    assert.equal(git("branch", "--list", "subagent/*"), "", "no branch left behind");
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
