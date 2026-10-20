import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RpcChild, type Packet } from "../extensions/subagents/src/rpc.js";
import { cliEnv } from "./host-env.js";
import { tempRoot } from "./support/temp-root.js";
const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const fixture = fileURLToPath(new URL("./fixtures/nest-parent-provider.mjs", import.meta.url));
const childFixture = fileURLToPath(new URL("./fixtures/nest-child-provider.mjs", import.meta.url));
const extension = fileURLToPath(new URL("../extensions/subagents/index.ts", import.meta.url));

test("a coordinator Child delegates to a worker through the root manager, within its subtree, and closing it cascades", { timeout: 90000, skip: process.platform === "win32" }, async () => {
  const root = tempRoot("nest-parent-"), agentDir = join(root, "agent"), bin = join(root, "bin"), work = join(root, "work");
  mkdirSync(agentDir); mkdirSync(bin); mkdirSync(work);
  if (process.env.PEER_TEST_EXECUTABLE) writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec '${process.env.PEER_TEST_EXECUTABLE}' "$@"\n`, { mode: 0o700 });
  else writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o700 });
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({
    version: 1, models: [{ id: "nest-test/stub:off" }], extensions: [childFixture], maxDepth: 2,
    tools: ["subagent_spawn", "subagent_wait", "subagent_read", "subagent_close", "subagent_list"],
  }));
  const proof = join(root, "proof.json"), events: Packet[] = []; let stderr = "";
  const parent = new RpcChild({ executable: process.env.PEER_TEST_EXECUTABLE ?? process.execPath,
    args: [...(process.env.PEER_TEST_EXECUTABLE ? [] : [cli]), "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve", "-e", extension, "-e", fixture, "--model", "nest-parent/stub", "--mode", "rpc", "--session", join(root, "parent.jsonl")],
    cwd: work, env: { ...cliEnv(), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PATH: `${bin}:${process.env.PATH}`, NEST_SMOKE_OUTPUT: proof },
    event: event => events.push(event), stderr: text => { stderr += text; }, exit: () => {},
  });
  try {
    await parent.request({ type: "get_state" });
    await parent.request({ type: "prompt", message: "NEST SMOKE" });
    for (let i = 0; i < 3500 && !existsSync(proof); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(proof), `${stderr}\n${JSON.stringify(events.slice(-10))}`);
    const result = JSON.parse(readFileSync(proof, "utf8"));
    assert.equal(result.error, undefined, result.error);
    const report = JSON.parse(result.report);
    assert.equal(report.spawnError, undefined, report.spawnError);
    assert.match(report.reply, /WORK DONE/, "the coordinator read its worker's result");
    assert.match(report.foreign, /not one of your Children/, "outside its subtree is refused");
    assert.match(report.deep, /depth 2 cannot delegate: maxDepth is 2/, "a worker at the deepest level cannot be given delegation");
    const worker = result.before.find((agent: Packet) => agent.name === "nest-worker");
    assert.deepEqual({ parentId: worker.parentId, depth: worker.depth }, { parentId: result.coordinator, depth: 2 });
    assert.equal(result.before.find((agent: Packet) => agent.id === result.coordinator).parentId, undefined);
    assert.equal(result.before.some((agent: Packet) => agent.name === "too-deep"), false, "the refused spawn left no record");
    assert.deepEqual(result.after.map((agent: Packet) => agent.status).sort(), ["stopped", "stopped"], "closing the coordinator closed its worker");
  } finally { await parent.stop(); rmSync(root, { recursive: true, force: true }); }
});
