import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RpcChild, type Packet } from "../extensions/subagents/src/rpc.js";
import { cliEnv } from "./host-env.js";
import { tempRoot } from "./support/temp-root.js";
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/peer-parent-provider.mjs", import.meta.url));
const childFixture = fileURLToPath(new URL("./fixtures/peer-provider.mjs", import.meta.url));
const extension = fileURLToPath(new URL("../extensions/subagents/index.ts", import.meta.url));

test("real parent tools authorize/inspect child peers without management recursion", { timeout: 45000, skip: process.platform === "win32" }, async () => {
  const root = tempRoot("peer-parent-"), agentDir = join(root, "agent"), bin = join(root, "bin");
  mkdirSync(agentDir); mkdirSync(bin);
  // Manager launches `pi`; choose a deterministic installed CLI, not a user's provider config.
  if (process.env.PEER_TEST_EXECUTABLE) writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec '${process.env.PEER_TEST_EXECUTABLE}' "$@"\n`, { mode: 0o700 });
  else writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o700 });
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "peer-test/stub:off" }], tools: ["peer_send"], extensions: [childFixture], peerMessageLimit: 2 }));
  const proof = join(root, "proof.json"), events: Packet[] = []; let stderr = "";
  const parent = new RpcChild({ executable: process.env.PEER_TEST_EXECUTABLE ?? process.execPath,
    args: [...(process.env.PEER_TEST_EXECUTABLE ? [] : [cli]), "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve", "-e", extension, "-e", fixture, "--model", "peer-parent/stub", "--mode", "rpc", "--session", join(root, "parent.jsonl")],
    cwd: root, env: { ...cliEnv(), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PATH: `${bin}:${process.env.PATH}`, PEER_SMOKE_OUTPUT: proof },
    event: event => events.push(event), stderr: text => { stderr += text; }, exit: () => {},
  });
  try {
    await parent.request({ type: "get_state" });
    await parent.request({ type: "prompt", message: "PEER SMOKE" });
    for (let i = 0; i < 500 && !existsSync(proof); i++) {
      if (events.some(e => e.type === "message_end" && Array.isArray(e.message?.content) && e.message.content.some((c: Packet) => c.text?.startsWith("PEER SMOKE FAILED")))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(proof), `${stderr}\n${JSON.stringify(events.slice(-15))}`);
    assert.equal(JSON.parse(readFileSync(proof, "utf8")).passed, true);
    assert.ok(events.some(e => e.type === "tool_execution_end" && e.toolName === "subagent_connect" && !e.isError));
    assert.ok(events.some(e => e.type === "tool_execution_end" && e.toolName === "subagent_peers" && !e.isError));
    assert.equal(events.some(e => e.type === "extension_error"), false, stderr);
  } finally { await parent.stop(); rmSync(root, { recursive: true, force: true }); }
});
