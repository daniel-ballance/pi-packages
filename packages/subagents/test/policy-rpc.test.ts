import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseChildLimit } from "../extensions/subagents/src/child-limit.js";
import { SubagentManager } from "../extensions/subagents/src/manager.js";
import { SubagentPolicy } from "../extensions/subagents/src/policy.js";
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/provider.mjs", import.meta.url));
const guard = fileURLToPath(new URL("../extensions/subagents/src/child-guard.ts", import.meta.url));

test("real RPC policy enforcement, mandatory guard, revalidated resume, and cleanup with invalid policy", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "policy-rpc-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = "1";
  let available = true;
  let policy: SubagentPolicy;
  const environment = {
    cwd: root, agentDir, projectTrusted: true, guardPath: guard,
    models: () => available ? [{ provider: "subagent-test", id: "stub", input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: {}, thinkingLevels: ["off"] }] : [],
    tools: () => ["read"],
  };
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "subagent-test/stub:off" }], tools: ["read"], extensions: [provider] }));
  policy = new SubagentPolicy(environment);
  const manager = new SubagentManager(join(root, "manager"), undefined, undefined, parseChildLimit(4), config => {
    if (!config.selection) throw new Error("Legacy configuration refused");
    return { ...policy.compile(config.cwd, config.selection), executable: process.execPath, executableArgs: [cli] };
  });
  try {
    const a = await manager.spawn({ name: "allowed", task: "Remember kiwi.", ...policy.compile(root, { model: "subagent-test/stub:off", tools: ["read"], extensions: [provider] }) });
    await manager.wait([a.id], "all", 5000);
    assert.equal(manager.get(a.id).status, "idle");
    await manager.close(a.id);
    available = false;
    await assert.rejects(manager.resume(a.id), /No spawnable/);
    assert.equal(manager.get(a.id).pid, undefined);
    available = true;
    await manager.resume(a.id, "Recall it.");
    await manager.wait([a.id], "all", 5000);
    assert.ok(manager.read(a.id).updates.some(u => u.kind === "assistant" && u.text.includes("Recall it.") && u.text.includes("kiwi")));
    writeFileSync(join(agentDir, "subagents.json"), "broken");
    policy = new SubagentPolicy(environment);
    assert.ok(manager.list().length);
    assert.ok(manager.read(a.id));
    await manager.close(a.id);
    await assert.rejects(manager.resume(a.id), /No spawnable/);
    // Existing unrestricted records never bypass the new policy on resume.
    await assert.rejects(manager.spawn({ name: "legacy", task: "x", cwd: root }), /Legacy/);
  } finally {
    await manager.shutdown();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("real RPC child loads alwaysExtensions without a parent selection", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "policy-rpc-always-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = "1";
  // The stub model exists only through the provider extension, so a successful turn proves it loaded.
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "subagent-test/stub:off" }], tools: ["read"], extensions: [provider], alwaysExtensions: [provider] }));
  const policy = new SubagentPolicy({
    cwd: root, agentDir, projectTrusted: true, guardPath: guard, tools: () => ["read"],
    models: () => [{ provider: "subagent-test", id: "stub", input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: {}, thinkingLevels: ["off"] }],
  });
  const manager = new SubagentManager(join(root, "manager"), undefined, undefined, parseChildLimit(4));
  try {
    const compiled = policy.compile(root, { model: "subagent-test/stub:off", tools: [] });
    const a = await manager.spawn({ name: "always", task: "Remember fig.", ...compiled, executable: process.execPath, executableArgs: [cli] });
    await manager.wait([a.id], "all", 5000);
    assert.equal(manager.get(a.id).status, "idle");
    assert.ok(manager.read(a.id).updates.some(u => u.kind === "assistant" && u.text.includes("fig")));
  } finally {
    await manager.shutdown();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
