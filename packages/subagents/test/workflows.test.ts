import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Workflows, parseVerdict } from "../src/workflows.js";
import { parseWorkflow, type WorkflowDefinition } from "../src/workflow-definition.js";
import type { WorkflowHost, AgentJob } from "../src/workflow-host.js";
import { runCommand } from "../src/workflow-host.js";

const worker = { model: "test/stub:off", tools: [] };
const task = (id: string, dependsOn: string[] = []) => ({ id, kind: "task" as const, worker, instructions: id, dependsOn });
const definition = (cwd: string, steps: WorkflowDefinition["steps"]): WorkflowDefinition => ({ version: 1, name: "test", cwd, limits: { concurrency: 2, maxAttempts: 20, timeoutSeconds: 30 }, steps });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function settled(engine: Workflows, id: string) {
  for (let n = 0; n < 400; n++) { const r = engine.get(id); if (!["running", "pausing"].includes(r.status)) { await sleep(5); return r; } await sleep(5); }
  assert.fail("Workflow did not settle");
}
function setup(overrides: Partial<WorkflowHost> = {}) {
  const root = mkdtempSync(join(tmpdir(), "workflow-test-"));
  const host: WorkflowHost = { authorize() {}, agents: async jobs => jobs.map(j => { writeFileSync(join(j.candidate, "value.txt"), j.step); return `Result ${j.step}`; }),
    command: runCommand, ...overrides };
  const engine = new Workflows(join(root, "runs"), host);
  return { root, host, engine, async close() { await engine.shutdown(); rmSync(root, { recursive: true, force: true }); } };
}
const idOf = (result: ReturnType<Workflows["start"]>) => (result as { id: string }).id;

test("definitions reject cycles, missing dependencies, invalid loop settings and impossible peer groups", () => {
  const def = definition("/tmp", [task("a"), task("b", ["a"])]);
  assert.equal(parseWorkflow(def).steps.length, 2);
  assert.throws(() => parseWorkflow({ ...def, steps: [task("a", ["b"]), task("b", ["a"])] }), /DAG/);
  assert.throws(() => parseWorkflow({ ...def, steps: [task("a", ["missing"])] }), /Unknown dependency/);
  assert.throws(() => parseWorkflow({ ...def, steps: [task("a"), task("a")] }), /unique/);
  assert.throws(() => parseWorkflow({ ...def, unexpected: true }), /Invalid workflow/);
  const loop = { id: "loop", kind: "loop", worker, instructions: "improve", mode: "improve", validator: { kind: "command", command: "true" }, maxIterations: 3 };
  assert.throws(() => parseWorkflow({ ...def, steps: [loop] }), /seed and direction/);
  const peers = { ...def, steps: ["a", "b", "c"].map(id => ({ ...task(id), worker: { ...worker, tools: ["peer_send"] } })), peers: [{ a: "a", b: "b", limit: 1 }, { a: "b", b: "c", limit: 1 }] };
  assert.throws(() => parseWorkflow(peers), /Concurrency/);
  assert.equal(parseWorkflow({ ...peers, limits: { ...def.limits, concurrency: 3 } }).steps.length, 3);
});

test("fan-out/fan-in schedules within concurrency and hands off artifact snapshots", async () => {
  let active = 0, peak = 0; const seen: AgentJob[] = [];
  const h = setup({ agents: async jobs => {
    active += jobs.length; peak = Math.max(peak, active); seen.push(...jobs); await sleep(20);
    active -= jobs.length;
    return jobs.map(j => { writeFileSync(join(j.candidate, "value.txt"), j.step); return `Result ${j.step}`; });
  } });
  try {
    const id = idOf(h.engine.start(definition(h.root, [task("a"), task("b"), task("synthesis", ["a", "b"])])));
    const run = await settled(h.engine, id);
    assert.equal(run.status, "succeeded"); assert.equal(peak, 2); assert.equal(run.usedAttempts, 3);
    assert.deepEqual(Object.keys(seen[2].inputs).sort(), ["a", "b"]);
    assert.equal(readFileSync(join(run.steps.a.output!.path, "value.txt"), "utf8"), "a");
    assert.equal(h.engine.pendingNotices().length, 1); h.engine.inspect(id); assert.equal(h.engine.pendingNotices().length, 0);
    assert.equal(Object.keys(run.steps).length, 3);
  } finally { await h.close(); }
});

test("repair loop carries candidate + feedback, invokes deterministic checks and stops on pass", async () => {
  const feedback: (string | undefined)[] = [];
  const h = setup({ agents: async jobs => jobs.map(j => {
    feedback.push(j.feedback); const path = join(j.candidate, "value.txt");
    const value = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
    writeFileSync(path, String(value + 1)); return "candidate";
  }) });
  try {
    const def = definition(h.root, [{ id: "fix", kind: "loop", mode: "repair", maxIterations: 5, worker, instructions: "repair",
      validator: { kind: "command", command: 'test "$(cat "$WORKFLOW_CANDIDATE/value.txt")" -ge 2' } }]);
    const run = await settled(h.engine, idOf(h.engine.start(def)));
    assert.equal(run.status, "succeeded"); assert.equal(run.usedAttempts, 4); assert.equal(run.steps.fix.iteration, 2);
    assert.match(feedback[1]!, /fail/); assert.equal(readFileSync(join(run.steps.fix.output!.path, "value.txt"), "utf8"), "2");
    assert.deepEqual(run.steps.fix.attempts.filter(a => a.verdict).map(a => a.verdict!.verdict), ["fail", "pass"]);
  } finally { await h.close(); }
});

test("improvement loop evaluates baseline, discards regression and retains best candidate", async () => {
  let iteration = 0; const seeds: number[] = [];
  const h = setup({ agents: async jobs => jobs.map(j => {
    const path = join(j.candidate, "value.txt");
    if (j.step === "seed") writeFileSync(path, "100");
    else { seeds.push(Number(readFileSync(path, "utf8"))); writeFileSync(path, String([90, 95, 80][iteration++])); }
    return "candidate";
  }), command: async (_command, _cwd, env) => ({ code: 0, stdout: JSON.stringify({ verdict: "pass", score: Number(readFileSync(join(env.WORKFLOW_CANDIDATE, "value.txt"), "utf8")) }) }) });
  try {
    const def = definition(h.root, [task("seed"), { id: "search", kind: "loop", mode: "improve", seed: "seed", direction: "min", maxIterations: 3,
      worker, instructions: "improve", validator: { kind: "command", command: "measure" } }]);
    const run = await settled(h.engine, idOf(h.engine.start(def)));
    assert.equal(run.status, "succeeded"); assert.equal(run.usedAttempts, 8);
    assert.deepEqual(seeds, [100, 90, 90]); assert.equal(run.steps.search.baselineVerdict?.score, 80);
    assert.equal(readFileSync(join(run.steps.search.output!.path, "value.txt"), "utf8"), "80");
    assert.equal(run.steps.search.attempts.filter(a => a.verdict).length, 4);
  } finally { await h.close(); }
});

test("total attempts bound workers and checks, not just iterations; exhaustion is not success", async () => {
  const h = setup({ command: async () => ({ code: 1, stdout: "needs repair" }) });
  try {
    const def = definition(h.root, [{ id: "fix", kind: "loop", mode: "repair", maxIterations: 10, worker, instructions: "fix", validator: { kind: "command", command: "false" } }]);
    def.limits.maxAttempts = 3;
    const run = await settled(h.engine, idOf(h.engine.start(def)));
    assert.equal(run.status, "exhausted"); assert.equal(run.usedAttempts, 3); assert.equal(run.steps.fix.output, undefined);
    await assert.rejects(h.engine.control(run.id, "resume", ["fix"]), /Only paused/);
    assert.equal(run.usedAttempts, 3);
  } finally { await h.close(); }
});

test("evaluator errors and artifact mutation block rather than count as validation failures", async () => {
  for (const mode of ["execution", "mutation", "invalid-json"]) {
    const h = setup({ command: async (_command, _cwd, env) => {
      if (mode === "mutation") writeFileSync(join(env.WORKFLOW_CANDIDATE, "value.txt"), "tampered");
      return { code: mode === "execution" ? 2 : 0, stdout: mode === "invalid-json" ? "{broken" : "passed" };
    } });
    try {
      const def = definition(h.root, [task("a"), { id: "check", kind: "check", input: "a", validator: { kind: "command", command: "check" } }]);
      const run = await settled(h.engine, idOf(h.engine.start(def)));
      assert.equal(run.status, "blocked", mode); assert.equal(run.steps.check.attempts[0].status, "error"); assert.equal(run.steps.check.output, undefined);
    } finally { await h.close(); }
  }
  assert.throws(() => parseVerdict('{"verdict":"pass","score":null}'));
});

test("human approval is explicit, tied to input, and never supplied by resume", async () => {
  const h = setup();
  try {
    const def = definition(h.root, [task("a"), { id: "approval", kind: "check", input: "a", validator: { kind: "human", instructions: "Accept this?" } }, task("publish", ["approval"])]);
    const id = idOf(h.engine.start(def)); let run = await settled(h.engine, id);
    assert.equal(run.steps.approval.status, "approval"); assert.equal(run.steps.publish.status, "pending");
    await assert.rejects(h.engine.control(id, "resume"), /Human approval/);
    h.engine.decide(id, "approval", "pass"); await h.engine.control(id, "resume"); run = await settled(h.engine, id);
    assert.equal(run.status, "succeeded"); assert.equal(run.usedAttempts, 3);
  } finally { await h.close(); }
});

test("existing workflow state permissions are repaired on reopen", { skip: process.platform === "win32" }, async () => {
  const h = setup();
  let restored: Workflows | undefined;
  try {
    const run = await settled(h.engine, idOf(h.engine.start(definition(h.root, [task("privacy")]))));
    chmodSync(h.engine.directory, 0o777); chmodSync(run.directory, 0o777); chmodSync(join(run.directory, "run.json"), 0o666);
    restored = new Workflows(h.engine.directory, h.host);
    assert.equal(statSync(h.engine.directory).mode & 0o777, 0o700);
    assert.equal(statSync(run.directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(run.directory, "run.json")).mode & 0o777, 0o600);
  } finally { await restored?.shutdown(); await h.close(); }
});

test("shutdown/reload does not replay; explicit retry preserves total allowance and deadline", async () => {
  const h = setup({ agents: async (_jobs, _links, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
  }) });
  let restored: Workflows | undefined;
  try {
    const id = idOf(h.engine.start(definition(h.root, [task("a")]))); await sleep(20);
    const deadline = h.engine.get(id).deadline; await h.engine.shutdown();
    restored = new Workflows(join(h.root, "runs"), { ...h.host, agents: async jobs => jobs.map(() => "retried") });
    assert.equal(restored.get(id).steps.a.status, "interrupted"); assert.equal(restored.get(id).usedAttempts, 1);
    await assert.rejects(restored.control(id, "resume"), /retry step IDs/);
    await restored.control(id, "resume", ["a"]); const run = await settled(restored, id);
    assert.equal(run.status, "succeeded"); assert.equal(run.usedAttempts, 2); assert.equal(run.deadline, deadline);
  } finally { await restored?.shutdown(); await h.close(); }
});

test("pause is a boundary, cancel and deadline abort execution, and only one run executes", async () => {
  const h = setup({ agents: async jobs => { await sleep(50); return jobs.map(() => "done"); } });
  try {
    const def = definition(h.root, [task("a"), task("b", ["a"])]);
    const id = idOf(h.engine.start(def)); await sleep(5);
    assert.throws(() => h.engine.start(def), /Another workflow/);
    await h.engine.control(id, "pause"); let run = await settled(h.engine, id);
    assert.equal(run.status, "paused"); assert.equal(run.steps.a.status, "passed"); assert.equal(run.steps.b.status, "pending");
    await h.engine.control(id, "resume"); run = await settled(h.engine, id); assert.equal(run.status, "succeeded");
    const commandDef = definition(h.root, [task("a"), { id: "slow", kind: "check", input: "a", validator: { kind: "command", command: "sleep 30" } }]);
    commandDef.limits.timeoutSeconds = 1;
    const slow = idOf(h.engine.start(commandDef)); run = await settled(h.engine, slow);
    assert.equal(run.status, "exhausted"); assert.match(run.reason!, /deadline/);
    const cancelled = idOf(h.engine.start(def)); await sleep(5); await h.engine.control(cancelled, "cancel");
    assert.equal(h.engine.get(cancelled).status, "cancelled"); assert.equal(h.engine.get(cancelled).steps.a.status, "interrupted");
  } finally { await h.close(); }
});
