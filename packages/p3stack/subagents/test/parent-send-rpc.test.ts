import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseChildLimit } from "../extensions/subagents/src/child-limit.js";
import { SubagentManager, type AgentRecord } from "../extensions/subagents/src/manager.js";
import { SubagentPolicy } from "../extensions/subagents/src/policy.js";
import { waitReport } from "../extensions/subagents/src/wait.js";
import { tempRoot } from "./support/temp-root.js";
const cli = process.env.PEER_TEST_CLI ?? fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const provider = fileURLToPath(new URL("./fixtures/peer-provider.mjs", import.meta.url));
const guard = fileURLToPath(new URL("../extensions/subagents/src/child-guard.ts", import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("real child parent_send: the pipe delivers, a working child wakes the parent's wait, and the limit holds", { timeout: 60000 }, async () => {
  const root = tempRoot("parent-send-rpc-");
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = "1";
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "peer-test/stub:off" }], tools: ["parent_send", "peer_test_hold"], extensions: [provider], parentMessageLimit: 2 }));
  const policy = new SubagentPolicy({ cwd: root, agentDir, projectTrusted: true, guardPath: guard,
    models: () => [{ provider: "peer-test", id: "stub", input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: {}, thinkingLevels: ["off"] }], tools: () => ["peer_test_hold"] });
  assert.equal(policy.catalog().parentMessageLimit, 2);
  assert.ok(policy.catalog().tools.includes("parent_send"));
  const authorize = (config: AgentRecord["config"]) => ({ ...policy.compile(config.cwd, config.selection!),
    executable: process.env.PEER_TEST_EXECUTABLE ?? process.execPath, executableArgs: process.env.PEER_TEST_EXECUTABLE ? [] : [cli] });
  const manager = new SubagentManager(join(root, "manager"), undefined, undefined, parseChildLimit(4), authorize, 0, 2);
  const spawn = (name: string, tools: string[]) => manager.spawn({ name, task: "Ready", ...policy.compile(root, { model: "peer-test/stub:off", tools, extensions: [provider] }) });
  const settle = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      if (manager.get(id).status === "idle") return;
      await delay(20);
    }
    assert.fail("Child did not settle");
  };
  const texts = (id: string, kind: string) => manager.get(id).updates.filter(update => update.kind === kind).map(update => update.text);
  try {
    const a = await spawn("scout", ["parent_send", "peer_test_hold"]); await settle(a.id);
    const tools = readFileSync(manager.get(a.id).logFile, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .find(event => event.entry?.customType === "child-policy-check").entry.data.tools as string[];
    assert.ok(tools.includes("parent_send"));

    // One message, then a slow tool: the wait ends on the message while the child still works.
    await manager.send(a.id, "TELL_HOLD found the bug in parser.ts");
    const end = await manager.wait([a.id], "all", 10000);
    assert.equal(end.wake, "child_message");
    assert.equal(manager.get(a.id).status, "working");
    const { report, receipts } = waitReport(manager, end, true);
    assert.ok(report.agents[0].reports?.some(r => r.kind === "message" && r.text === "found the bug in parser.ts"));
    for (const receipt of receipts) manager.acknowledgeRead(receipt, true);
    assert.equal((await manager.wait([a.id], "all", 10000)).wake, "settled");

    // A new assignment has a fresh allowance of 2; the third send in it is refused.
    await manager.send(a.id, "TELL 3 progress"); await settle(a.id);
    assert.deepEqual(texts(a.id, "message").slice(-2), ["progress #1", "progress #2"]);
    assert.match(texts(a.id, "assistant").join("\n"), /Message limit reached for this assignment \(2\)/);
    assert.ok(manager.pendingNotices().some(notice => notice.id === a.id && notice.kind === "message"));

    // A child that did not select parent_send has no such tool.
    const b = await spawn("quiet", ["peer_test_hold"]); await settle(b.id);
    await manager.send(b.id, "TELL 1 hello"); await settle(b.id);
    assert.equal(texts(b.id, "message").length, 0);
  } finally {
    await manager.shutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
