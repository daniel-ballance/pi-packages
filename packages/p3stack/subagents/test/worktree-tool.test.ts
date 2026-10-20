import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { asHost } from "./host-env.js";
import { git as runGit } from "./git.js";
import { tempRoot } from "./support/temp-root.js";

async function withSpawnTool(workingDirectories: string[], run: (spawn: (args: Record<string, unknown>) => Promise<unknown>, repo: string, git: (...args: string[]) => string, root: string) => Promise<void>) {
  const root = tempRoot("worktree-tool-"), repo = join(root, "repo"), agentDir = join(root, "agent");
  mkdirSync(join(repo, "src"), { recursive: true }); mkdirSync(agentDir);
  const git = (...args: string[]) => runGit(["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "src/a.ts"), "1\n");
  git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  // The model and tools are always allowed; tests vary only workingDirectories.
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "p/m:off" }], tools: [], workingDirectories }));
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
    await run(args => tools.get("subagent_spawn").execute("c", args, undefined, undefined, ctx), repo, git, root);
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("a worktree outside workingDirectories is refused before git writes anything", async () => {
  await withSpawnTool(["./src"], async (spawn, repo, git) => {
    await assert.rejects(spawn({ name: "outside", task: "x", cwd: join(repo, "src"), model: "p/m:off", tools: [], worktree: true }), (error: Error) => {
      assert.equal(error.message.includes(`cwd ${join(repo, ".pi", "worktrees")}`), true, error.message);
      assert.equal(error.message.includes(realpathSync(join(repo, "src"))), true, error.message);
      return true;
    });
    assert.equal(existsSync(join(repo, ".pi")), false, "refused before git wrote anything");
    assert.equal(git("worktree", "list").split("\n").length, 1, "no worktree left behind");
    assert.equal(git("branch", "--list", "subagent/*"), "", "no branch left behind");
  });
});

test("when the child fails to launch, its new worktree and branch are removed", { skip: process.platform === "win32" }, async () => {
  await withSpawnTool(["."], async (spawn, repo, git, root) => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      await assert.rejects(spawn({ name: "broken", task: "x", cwd: repo, model: "p/m:off", tools: [], worktree: true }));
    } finally { process.env.PATH = previousPath; }
    assert.equal(git("worktree", "list").split("\n").length, 1, "no worktree left behind");
    assert.equal(git("branch", "--list", "subagent/*"), "", "no branch left behind");
  });
});
