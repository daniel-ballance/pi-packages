import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { createWorktree } from "../extensions/subagents/src/worktree.js";
import { asHost } from "./host-env.js";
import { git } from "./git.js";

function scratch(label: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `worktree-git-env-${label}-`)));
  const run = (...args: string[]) => git(["-C", root, ...args], { encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "hello\n");
  run("add", ".");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return { root, git: run, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function snapshot(repo: ReturnType<typeof scratch>) {
  return { branches: repo.git("branch", "--list"), bare: repo.git("config", "--get", "core.bare") };
}

async function withDecoy(run: (decoy: ReturnType<typeof scratch>, target: ReturnType<typeof scratch>) => Promise<void> | void) {
  const decoy = scratch("decoy");
  const target = scratch("target");
  const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(decoy.root, ".git");
  process.env.GIT_WORK_TREE = decoy.root;
  try {
    await run(decoy, target);
  } finally {
    if (previous.GIT_DIR === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous.GIT_DIR;
    if (previous.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previous.GIT_WORK_TREE;
    decoy.dispose();
    target.dispose();
  }
}

test("createWorktree and the worktree tool ignore GIT_DIR and write the requested repository", { timeout: 20000 }, async () => {
  const problems: string[] = [];
  await withDecoy((decoy, target) => {
    const before = snapshot(decoy);
    const created = createWorktree({ cwd: target.root, name: "isolated" });
    const after = snapshot(decoy);
    if (after.branches !== before.branches) problems.push(`createWorktree changed GIT_DIR branches to ${JSON.stringify(after.branches)}`);
    if (after.bare !== before.bare) problems.push(`createWorktree changed GIT_DIR core.bare to ${JSON.stringify(after.bare)}`);
    if (!created.path.startsWith(`${target.root}/.pi/worktrees/`) || !existsSync(join(created.path, "README.md"))) {
      problems.push(`createWorktree wrote ${created.path}, not ${target.root}`);
    }
  });

  if (process.platform !== "win32") await withDecoy(async (decoy, target) => {
    const before = snapshot(decoy);
    const root = realpathSync(tmpdir());
    const proof = join(root, `worktree-git-env-proof-${process.pid}`);
    const bin = join(root, `worktree-git-env-bin-${process.pid}`);
    mkdirSync(bin);
    writeFileSync(join(bin, "pi"), "#!/bin/sh\nprintf '%s\\n' \"$PWD\" > \"$PROOF\"\ntest -f \"$PWD/README.md\" && printf 'readme\\n' >> \"$PROOF\"\nexit 1\n", { mode: 0o755 });
    const agentDir = join(root, `worktree-git-env-agent-${process.pid}`);
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "p/m:off" }], tools: [], workingDirectories: [root] }));
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousPath = process.env.PATH;
    const previousProof = process.env.PROOF;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.PROOF = proof;
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    const handlers = new Map<string, Function[]>();
    const ctx = {
      cwd: target.root, mode: "rpc", hasUI: false, isIdle: () => true, isProjectTrusted: () => false,
      modelRegistry: { getAvailable: () => [{ provider: "p", id: "m", input: ["text"], contextWindow: 1000, maxTokens: 100, cost: {}, reasoning: false }] },
      ui: { notify() {}, setStatus() {} }, sessionManager: { getEntries: () => [], getSessionId: () => "s", getSessionFile: () => join(agentDir, "s.jsonl") },
    };
    try {
      asHost("cli", () => {
        subagents({
          registerFlag() {}, getFlag() { return false; },
          on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
          registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
          registerCommand() {}, sendMessage() {},
          getAllTools: () => [], events: { on: () => () => {} },
        } as unknown as ExtensionAPI);
        for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
      });
      await assert.rejects(tools.get("subagent_spawn")!.execute("c", { name: "isolated", task: "x", cwd: target.root, model: "p/m:off", tools: [], worktree: true }, undefined, undefined, ctx));
      const landed = existsSync(proof) ? readFileSync(proof, "utf8") : "";
      if (!landed.startsWith(`${target.root}/.pi/worktrees/`) || !landed.includes("readme")) problems.push(`worktree tool ran in ${JSON.stringify(landed)}`);
      const after = snapshot(decoy);
      if (after.branches !== before.branches) problems.push(`worktree tool left GIT_DIR branches as ${JSON.stringify(after.branches)}`);
      if (after.bare !== before.bare) problems.push(`worktree tool left GIT_DIR core.bare as ${JSON.stringify(after.bare)}`);
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousProof === undefined) delete process.env.PROOF;
      else process.env.PROOF = previousProof;
      rmSync(bin, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(proof, { force: true });
    }
  });

  assert.deepEqual(problems, []);
});
