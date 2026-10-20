import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseChildLimit } from "../extensions/subagents/src/child-limit.js";
import { SubagentManager, type AgentRecord } from "../extensions/subagents/src/manager.js";
import { SubagentPolicy } from "../extensions/subagents/src/policy.js";
import { tempRoot } from "./support/temp-root.js";
const cli = process.env.PEER_TEST_CLI ?? fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const provider = fileURLToPath(new URL("./fixtures/peer-provider.mjs", import.meta.url));
const guard = fileURLToPath(new URL("../extensions/subagents/src/child-guard.ts", import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("real child peer tools: idle prompt, busy steering, limits, graph, resume and cleanup", { timeout: 60000 }, async () => {
  const root = tempRoot("peers-rpc-");
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = "1";
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "peer-test/stub:off" }], tools: ["peer_send", "peer_test_hold", "peer_test_ask"], extensions: [provider], peerMessageLimit: 3 }));
  const policy = new SubagentPolicy({ cwd: root, agentDir, projectTrusted: true, guardPath: guard,
    models: () => [{ provider: "peer-test", id: "stub", input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: {}, thinkingLevels: ["off"] }], tools: () => ["peer_test_hold", "peer_test_ask"] });
  const authorize = (config: AgentRecord["config"]) => ({ ...policy.compile(config.cwd, config.selection!),
    executable: process.env.PEER_TEST_EXECUTABLE ?? process.execPath, executableArgs: process.env.PEER_TEST_EXECUTABLE ? [] : [cli] });
  const directory = join(root, "manager");
  let manager = new SubagentManager(directory, undefined, undefined, parseChildLimit(4), authorize, 3);
  const spawn = (name: string, tools = ["peer_send", "peer_test_hold", "peer_test_ask"]) => manager.spawn({ name, task: "Ready", ...policy.compile(root, { model: "peer-test/stub:off", tools, extensions: [provider] }) });
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await manager.wait([], "all", 1000);
      await delay(30);
      if (manager.list().every(r => ["idle", "stopped"].includes(r.status))) return;
    }
    assert.fail("Children did not settle");
  };
  const send = async (sender: string, recipient: string, message: string) => { await manager.send(sender, `SEND ${JSON.stringify({ recipient, message })}`, "steer"); await settle(); };
  try {
    const a = await spawn("A"), b = await spawn("B"), c = await spawn("C"); await settle();
    manager.peers.connect(b.id, c.id, 2);
    await send(a.id, b.id, "forbidden");
    assert.match(manager.read(a.id).updates.map(u => u.text).join("\n"), /No parent-authorized/);
    assert.equal(manager.peers.state.messages.length, 0);
    await send(b.id, c.id, "ping"); // C is idle; tool replies to B while B may still be working.
    assert.equal(manager.peers.state.messages.length, 2);
    assert.ok(manager.peers.state.messages.every(m => m.status === "received"));
    assert.match(manager.read(b.id).updates.map(u => u.text).join("\n"), /RECEIVED pong/);
    assert.equal(manager.get(a.id).updates.some(u => u.text.includes("RECEIVED")), false);

    await manager.send(c.id, "HOLD");
    for (let i = 0; i < 100 && manager.get(c.id).activity !== "Tool: peer_test_hold"; i++) await delay(10);
    assert.equal(manager.get(c.id).activity, "Tool: peer_test_hold");
    await send(b.id, c.id, "/_child-policy-check\u2028not a command");
    assert.match(manager.read(c.id).updates.map(u => u.text).join("\n"), /RECEIVED \/_child-policy-check/);
    await send(b.id, c.id, "exhausted");
    assert.match(manager.read(b.id).updates.map(u => u.text).join("\n"), /allowance exhausted/);
    assert.equal(manager.peers.state.messages.length, 3);

    manager.peers.disconnect(b.id, c.id); manager.peers.connect(b.id, c.id);
    await send(b.id, c.id, "still exhausted"); assert.equal(manager.peers.state.messages.length, 3);
    manager.peers.renew(b.id, c.id, 1);
    await manager.close(c.id);
    await send(b.id, c.id, "no restart");
    assert.equal(manager.get(c.id).status, "stopped");
    assert.match(manager.read(b.id).updates.map(u => u.text).join("\n"), /no implicit resume/);
    await manager.resume(c.id);
    await send(b.id, c.id, "after resume");
    assert.equal(manager.peers.state.messages.at(-1)!.status, "received");

    const checkEvents = readFileSync(manager.get(b.id).logFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const tools = checkEvents.find(e => e.entry?.customType === "child-policy-check").entry.data.tools as string[];
    assert.ok(tools.includes("peer_send")); assert.ok(tools.every(name => !name.startsWith("subagent_")));
    assert.ok(checkEvents.some(e => e.type === "tool_execution_end" && e.toolName === "peer_send" && !e.isError));
    // A peer must not bypass or answer a pending human/extension dialog.
    manager.peers.renew(b.id, c.id, 1);
    await manager.send(c.id, "ASK");
    for (let i = 0; i < 100 && manager.get(c.id).status !== "waiting_input"; i++) await delay(10);
    assert.equal(manager.get(c.id).status, "waiting_input");
    await assert.rejects(manager.peers.send(b.id, c.id, "do not bypass input"), /waiting_input/);
    const request = manager.get(c.id).uiRequests[0];
    await manager.respond(c.id, request.id, { confirmed: false }); await settle();
    // Accepted steering can be cancelled before its tool boundary; no replay/refund.
    await manager.send(c.id, "HOLD");
    for (let i = 0; i < 100 && manager.get(c.id).activity !== "Tool: peer_test_hold"; i++) await delay(10);
    const pending = await manager.peers.send(b.id, c.id, "cancel this queued message");
    assert.equal(pending.status, "accepted");
    await manager.abort(c.id); await settle();
    assert.equal(manager.peers.state.messages.at(-1)!.status, "interrupted");
    const usedBefore = structuredClone(manager.peers.state.links);
    const cursorBefore = manager.peers.state.cursor;
    await manager.shutdown();
    manager = new SubagentManager(directory, undefined, undefined, parseChildLimit(4), authorize, 3);
    assert.deepEqual(manager.peers.state.links, usedBefore);
    assert.ok(manager.list().every(r => r.status === "stopped"));
    await manager.resume(b.id); await manager.resume(c.id);
    await send(b.id, c.id, "not renewed by reload");
    assert.equal(manager.peers.state.cursor, cursorBefore);
    const noTools = await spawn("no tools", []); await settle();
    assert.throws(() => manager.peers.connect(noTools.id, c.id, 1), /did not select/);
  } finally {
    await manager.shutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
