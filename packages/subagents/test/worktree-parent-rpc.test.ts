import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RpcChild, type Packet } from "../extensions/subagents/src/rpc.js";
import { cliEnv } from "./host-env.js";
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/worktree-parent-provider.mjs", import.meta.url));
const childFixture = fileURLToPath(new URL("./fixtures/peer-provider.mjs", import.meta.url));
const extension = fileURLToPath(new URL("../extensions/subagents/index.ts", import.meta.url));

test("a real parent spawns a child in a new git worktree under .pi/worktrees", { timeout: 45000, skip: process.platform === "win32" }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-parent-"))), agentDir = join(root, "agent"), bin = join(root, "bin"), repo = join(root, "repo");
  mkdirSync(agentDir); mkdirSync(bin); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".pi/worktrees/\n");
  git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  if (process.env.PEER_TEST_EXECUTABLE) writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec '${process.env.PEER_TEST_EXECUTABLE}' "$@"\n`, { mode: 0o700 });
  else writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o700 });
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "peer-test/stub:off" }], tools: [], extensions: [childFixture] }));
  const proof = join(root, "proof.json"), events: Packet[] = []; let stderr = "";
  const parent = new RpcChild({ executable: process.env.PEER_TEST_EXECUTABLE ?? process.execPath,
    args: [...(process.env.PEER_TEST_EXECUTABLE ? [] : [cli]), "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve", "-e", extension, "-e", fixture, "--model", "worktree-parent/stub", "--mode", "rpc", "--session", join(root, "parent.jsonl")],
    cwd: repo, env: { ...cliEnv(), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PATH: `${bin}:${process.env.PATH}`, WORKTREE_SMOKE_OUTPUT: proof },
    event: event => events.push(event), stderr: text => { stderr += text; }, exit: () => {},
  });
  try {
    await parent.request({ type: "get_state" });
    await parent.request({ type: "prompt", message: "WORKTREE SMOKE" });
    for (let i = 0; i < 500 && !existsSync(proof); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(proof), `${stderr}\n${JSON.stringify(events.slice(-10))}`);
    const { spawned, listed, error } = JSON.parse(readFileSync(proof, "utf8"));
    assert.equal(error, undefined, error);
    assert.match(spawned.worktree.path, new RegExp(`^${repo}/\\.pi/worktrees/worktree-smoke-[0-9a-f]{6}$`));
    assert.equal(spawned.worktree.ignored, true);
    assert.equal(listed.cwd, spawned.worktree.path, "the child runs in the new checkout");
    assert.match(git("worktree", "list"), /worktree-smoke-/);
    assert.equal(git("branch", "--list", spawned.worktree.branch).replace(/^[*+ ]+/, ""), spawned.worktree.branch);
  } finally { await parent.stop(); rmSync(root, { recursive: true, force: true }); }
});
