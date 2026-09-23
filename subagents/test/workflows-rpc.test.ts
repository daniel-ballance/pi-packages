import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SubagentManager, type AgentRecord } from "../src/manager.js";
import { SubagentPolicy } from "../src/policy.js";
import { Workflows } from "../src/workflows.js";
import { managerWorkflowHost } from "../src/workflow-host.js";
import type { WorkflowDefinition } from "../src/workflow-definition.js";
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/workflow-provider.mjs", import.meta.url));
const guard = fileURLToPath(new URL("../src/child-guard.ts", import.meta.url));

test("real Pi workflows: DAG, repair, improvement, reviewer, scoped peer group and cleanup", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "workflows-rpc-")), agentDir = join(root, "agent"); mkdirSync(agentDir);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = "1";
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "workflow-test/stub:off" }], tools: ["write", "read", "bash", "peer_send"], extensions: [provider], peerMessageLimit: 2 }));
  const policy = new SubagentPolicy({ cwd: root, agentDir, projectTrusted: true, guardPath: guard,
    models: () => [{ provider: "workflow-test", id: "stub", input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: {}, thinkingLevels: ["off"] }], tools: () => ["write", "read", "bash"] });
  const manager = new SubagentManager(join(root, "manager"), undefined, undefined, 4, (config: AgentRecord["config"]) => ({ ...policy.compile(config.cwd, config.selection!),
    executable: process.env.PEER_TEST_EXECUTABLE ?? process.execPath, executableArgs: process.env.PEER_TEST_EXECUTABLE ? [] : [cli] }), 2);
  const engine = new Workflows(join(manager.directory, "workflows"), managerWorkflowHost(manager, () => policy));
  const worker = { model: "workflow-test/stub:off", tools: ["write"], extensions: [provider] };
  const task = (id: string, instructions = "fixture:plain", dependsOn: string[] = []) => ({ id, kind: "task" as const, worker, instructions, dependsOn });
  const def = (steps: WorkflowDefinition["steps"]): WorkflowDefinition => ({ version: 1, name: "RPC workflow", cwd: root, limits: { concurrency: 2, maxAttempts: 30, timeoutSeconds: 30 }, steps });
  async function run(definition: WorkflowDefinition) {
    const result = engine.start(definition) as { id: string };
    for (let i = 0; i < 1000 && ["running", "pausing"].includes(engine.get(result.id).status); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const run = engine.get(result.id);
    assert.equal(run.status, "succeeded", JSON.stringify(engine.inspect(run.id)));
    assert.equal(manager.list().filter(a => a.pid).length, 0);
    assert.equal(manager.pendingNotices().length, 0, "Worker chatter must not notify the supervising parent");
    return run;
  }
  try {
    const dag = await run(def([task("a"), task("b"), task("synthesis", "fixture:plain", ["a", "b"]),
      { id: "review", kind: "check", input: "synthesis", validator: { kind: "agent", worker: { ...worker, tools: ["read"] }, instructions: "fixture:review" } }]));
    assert.equal(dag.usedAttempts, 4); assert.equal(dag.steps.review.attempts[0].verdict?.verdict, "pass");
    const repair = await run(def([{ id: "repair", kind: "loop", mode: "repair", worker, instructions: "fixture:repair", maxIterations: 4,
      validator: { kind: "command", command: 'test "$(cat "$WORKFLOW_CANDIDATE/value.txt")" -ge 2' } }]));
    assert.equal(repair.steps.repair.iteration, 2); assert.equal(repair.usedAttempts, 4);
    const search = await run(def([task("seed", "fixture:seed"), { id: "search", kind: "loop", mode: "improve", worker, instructions: "fixture:improve", seed: "seed", direction: "min", maxIterations: 3,
      validator: { kind: "command", command: 'printf \'{"verdict":"pass","score":%s}\\n\' "$(cat "$WORKFLOW_CANDIDATE/value.txt")"' } }]));
    assert.equal(search.steps.search.baselineVerdict?.score, 80);
    assert.deepEqual(search.steps.search.attempts.filter(a => a.decision).map(a => a.decision), ["keep", "keep", "discard", "keep"]);
    const peerDef = def([{ ...task("b", "fixture:peer-b"), worker: { ...worker, tools: ["peer_send"] } }, { ...task("c", "fixture:peer-c"), worker: { ...worker, tools: ["peer_send"] } }]);
    peerDef.peers = [{ a: "b", b: "c", limit: 1 }];
    const peers = await run(peerDef);
    assert.equal(peers.usedAttempts, 2);
    assert.equal(manager.peers.state.messages.length, 2);
    assert.ok(manager.peers.state.messages.every(m => m.status === "received"));
    assert.ok(manager.peers.state.links.every(l => !l.enabled));
    for (const child of manager.list()) {
      assert.ok(child.workflow); assert.equal(child.status, "stopped");
      const events = readFileSync(child.logFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      const tools = events.find(e => e.message?.customType === "child-policy-check").message.details.tools as string[];
      assert.ok(tools.every(name => !name.startsWith("subagent_")));
      assert.equal(events.some(e => e.type === "extension_error"), false);
    }
    assert.throws(() => policy.compile(root, { ...worker, tools: ["subagent_workflow_start"] }), /not allowed/);
  } finally {
    await engine.shutdown(); await manager.shutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
