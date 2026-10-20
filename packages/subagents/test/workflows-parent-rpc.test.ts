import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RpcChild, type Packet } from "../extensions/subagents/src/rpc.js";
import { cliEnv } from "./host-env.js";
import { tempRoot } from "./support/temp-root.js";
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const parentFixture = fileURLToPath(new URL("./fixtures/workflow-parent-provider.mjs", import.meta.url));
const childFixture = fileURLToPath(new URL("./fixtures/workflow-provider.mjs", import.meta.url));
const extension = fileURLToPath(new URL("../extensions/subagents/index.ts", import.meta.url));

test("real parent launches autonomous workflow, gets one completion notice, and inspects evidence", { timeout: 45000, skip: process.platform === "win32" }, async () => {
  const root = tempRoot("workflow-parent-"), agentDir = join(root, "agent"), bin = join(root, "bin"); mkdirSync(agentDir); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), process.env.PEER_TEST_EXECUTABLE ? `#!/bin/sh\nexec '${process.env.PEER_TEST_EXECUTABLE}' "$@"\n` : `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o700 });
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "workflow-test/stub:off" }], tools: ["write", "bash"], extensions: [childFixture] }));
  const worker = { model: "workflow-test/stub:off", tools: ["write"], extensions: [childFixture] };
  const definition = join(root, "workflow.json"), proof = join(root, "proof.json");
  writeFileSync(definition, JSON.stringify({ version: 1, name: "autonomous repair", cwd: root, limits: { concurrency: 2, maxAttempts: 10, timeoutSeconds: 20 }, steps: [
    { id: "repair", kind: "loop", mode: "repair", worker, instructions: "fixture:repair", maxIterations: 4, validator: { kind: "command", command: 'test "$(cat "$WORKFLOW_CANDIDATE/value.txt")" -ge 2' } },
  ] }));
  const events: Packet[] = []; let stderr = "";
  const parent = new RpcChild({ executable: process.env.PEER_TEST_EXECUTABLE ?? process.execPath,
    args: [...(process.env.PEER_TEST_EXECUTABLE ? [] : [cli]), "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--approve", "-e", extension, "-e", parentFixture, "--model", "workflow-parent/stub", "--mode", "rpc", "--session", join(root, "parent.jsonl")],
    cwd: root, env: { ...cliEnv(), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PATH: `${bin}:${process.env.PATH}`, WORKFLOW_SMOKE_OUTPUT: proof, WORKFLOW_SMOKE_DEFINITION: definition },
    event: e => events.push(e), stderr: text => { stderr += text; }, exit: () => {},
  });
  try {
    await parent.request({ type: "get_state" }); await parent.request({ type: "prompt", message: "WORKFLOW SMOKE" });
    for (let i = 0; i < 1000 && !existsSync(proof); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(proof), `${stderr}\n${JSON.stringify(events.slice(-10))}`);
    const result = JSON.parse(readFileSync(proof, "utf8"));
    assert.equal(result.status, "succeeded"); assert.equal(result.usedAttempts, 4);
    assert.equal(result.steps[0].iteration, 2);
    const notices = events.filter(e => e.type === "message_end" && e.message?.customType === "subagent-report");
    assert.equal(notices.length, 1, "Only workflow completion, not every child result");
    assert.equal(events.some(e => e.type === "extension_error"), false, stderr);
    const registry = JSON.parse(readFileSync(join(result.directory, "../../registry.json"), "utf8"));
    assert.ok(registry.agents.every((a: Packet) => a.status === "stopped" && !a.pid));
  } finally { await parent.stop(); rmSync(root, { recursive: true, force: true }); }
});
