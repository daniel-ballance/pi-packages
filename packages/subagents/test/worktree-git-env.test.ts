import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { runCommand } from "../extensions/subagents/src/workflow-host.js";
import { createWorktree, gitEnv } from "../extensions/subagents/src/worktree.js";
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
    writeFileSync(join(bin, "pi"), "#!/bin/sh\n{\nprintf '%s\\n' \"$PWD\"\ntest -f \"$PWD/README.md\" && printf 'readme\\n'\nif [ -n \"${GIT_DIR+x}\" ]; then printf 'git_dir %s\\n' \"$GIT_DIR\"; else printf 'git_dir unset\\n'; fi\ntoplevel=$(git rev-parse --show-toplevel 2>/dev/null) || toplevel=missing\nprintf 'toplevel %s\\n' \"$toplevel\"\n} > \"$PROOF\"\nexit 1\n", { mode: 0o755 });
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
      const gitDir = landed.split("\n").find(line => line.startsWith("git_dir "))?.slice("git_dir ".length);
      const toplevel = landed.split("\n").find(line => line.startsWith("toplevel "))?.slice("toplevel ".length);
      const cwd = landed.split("\n")[0];
      if (gitDir !== "unset") problems.push(`child saw GIT_DIR=${JSON.stringify(gitDir)}`);
      if (toplevel !== cwd) problems.push(`child toplevel ${JSON.stringify(toplevel)} is not its worktree ${JSON.stringify(cwd)}`);
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

test("workflow commands ignore inherited GIT_DIR and run in the named directory", { timeout: 20000, skip: process.platform === "win32" }, async () => {
  await withDecoy(async (_decoy, target) => {
    const logDir = mkdtempSync(join(realpathSync(tmpdir()), `worktree-git-env-log-${process.pid}-`));
    try {
      const result = await runCommand(
        'if [ -n "${GIT_DIR+x}" ]; then printf "git_dir %s\n" "$GIT_DIR"; else printf "git_dir unset\n"; fi; printf "toplevel %s\n" "$(git rev-parse --show-toplevel)"',
        target.root,
        {},
        logDir,
        new AbortController().signal,
      );
      assert.equal(result.code, 0, result.stdout);
      assert.match(result.stdout, /^git_dir unset\n/, result.stdout);
      const toplevel = result.stdout.split("\n").find(line => line.startsWith("toplevel "))?.slice("toplevel ".length);
      assert.equal(realpathSync(toplevel!), realpathSync(target.root));
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

test("gitEnv keeps GIT_CONFIG_COUNT and still ignores GIT_DIR", () => {
  const repo = scratch("config");
  const decoy = scratch("config-decoy");
  try {
    const env = gitEnv({
      ...process.env,
      GIT_DIR: join(decoy.root, ".git"),
      GIT_WORK_TREE: decoy.root,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "demo.key",
      GIT_CONFIG_VALUE_0: "kept",
      GIT_CONFIG_PARAMETERS: "'demo.other=also'",
    });
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "demo.key");
    assert.equal(env.GIT_CONFIG_VALUE_0, "kept");
    assert.equal(env.GIT_CONFIG_PARAMETERS, "'demo.other=also'");
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_WORK_TREE, undefined);
    const got = execFileSync("git", ["-C", repo.root, "config", "--get", "demo.key"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
    assert.equal(got, "kept");
    const other = execFileSync("git", ["-C", repo.root, "config", "--get", "demo.other"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
    assert.equal(other, "also");
    const top = execFileSync("git", ["-C", repo.root, "rev-parse", "--show-toplevel"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
    assert.equal(realpathSync(top), realpathSync(repo.root));
  } finally {
    repo.dispose();
    decoy.dispose();
  }
});

test("gitEnv discovers repository variables lazily and caches them", { skip: process.platform === "win32" }, () => {
  const bin = mkdtempSync(join(tmpdir(), "worktree-git-env-discovery-"));
  const source = pathToFileURL(join(import.meta.dirname, "../extensions/subagents/src/worktree.ts")).href;
  const log = join(bin, "calls");
  writeFileSync(join(bin, "git"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DISCOVERY_LOG"\nprintf "%s\\n" GIT_DIR GIT_FUTURE_LOCAL GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS\n', { mode: 0o755 });
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { existsSync } from "node:fs";
      import { gitEnv } from ${JSON.stringify(source)};
      assert.equal(existsSync(process.env.DISCOVERY_LOG), false);
      const base = { GIT_FUTURE_LOCAL: "remove", GIT_DIR: process.env.DECOY, KEEP: "yes" };
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(gitEnv(base), { KEEP: "yes" });
      }
      assert.equal(base.GIT_FUTURE_LOCAL, "remove");
    `], { encoding: "utf8", env: { ...process.env, PATH: bin, DISCOVERY_LOG: log, DECOY: join(bin, ".git") }, cwd: join(import.meta.dirname, "..") });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(log, "utf8"), "rev-parse --local-env-vars\n");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("gitEnv still drops GIT_DIR when git cannot name its variables", () => {
  const empty = mkdtempSync(join(tmpdir(), "worktree-git-env-nopath-"));
  const source = pathToFileURL(join(import.meta.dirname, "../extensions/subagents/src/worktree.ts")).href;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { gitEnv } from ${JSON.stringify(source)};
      const env = gitEnv({
        ...process.env,
        GIT_DIR: process.env.DECOY,
        GIT_WORK_TREE: process.env.DECOY,
        GIT_INDEX_FILE: process.env.DECOY,
        GIT_COMMON_DIR: process.env.DECOY,
        GIT_OBJECT_DIRECTORY: process.env.DECOY,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "demo.key",
        GIT_CONFIG_VALUE_0: "kept",
      });
      console.log(JSON.stringify({
        GIT_DIR: env.GIT_DIR ?? null,
        GIT_WORK_TREE: env.GIT_WORK_TREE ?? null,
        GIT_INDEX_FILE: env.GIT_INDEX_FILE ?? null,
        GIT_COMMON_DIR: env.GIT_COMMON_DIR ?? null,
        GIT_OBJECT_DIRECTORY: env.GIT_OBJECT_DIRECTORY ?? null,
        GIT_CONFIG_COUNT: env.GIT_CONFIG_COUNT ?? null,
        GIT_CONFIG_VALUE_0: env.GIT_CONFIG_VALUE_0 ?? null,
      }));
    `], { encoding: "utf8", env: { ...process.env, PATH: empty, DECOY: join(empty, ".git") }, cwd: join(import.meta.dirname, "..") });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      GIT_DIR: null,
      GIT_WORK_TREE: null,
      GIT_INDEX_FILE: null,
      GIT_COMMON_DIR: null,
      GIT_OBJECT_DIRECTORY: null,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_VALUE_0: "kept",
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
