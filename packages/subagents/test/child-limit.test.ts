import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { allows, capacityOf, limitLabel, OMITTED_CHILD_LIMIT, parseChildLimit, reportedLimit } from "../extensions/subagents/src/child-limit.js";
import { SubagentManager } from "../extensions/subagents/src/manager.js";
import { SubagentPolicy } from "../extensions/subagents/src/policy.js";
import { authorizeWorkflow, parseWorkflow } from "../extensions/subagents/src/workflow-definition.js";
import { managerWorkflowHost } from "../extensions/subagents/src/workflow-host.js";

const INVALID = /maxChildren must be a positive integer, 0 to disable spawning, or -1 for no limit/;

const parsed: { name: string; value: unknown; limit?: { kind: string; max?: number } }[] = [
  { name: "omitted", value: undefined, limit: { kind: "capped", max: 4 } },
  { name: "0", value: 0, limit: { kind: "off" } },
  { name: "1", value: 1, limit: { kind: "capped", max: 1 } },
  { name: "65", value: 65, limit: { kind: "capped", max: 65 } },
  { name: "large safe integer", value: Number.MAX_SAFE_INTEGER, limit: { kind: "capped", max: Number.MAX_SAFE_INTEGER } },
  { name: "-1", value: -1, limit: { kind: "unlimited" } },
  { name: "-2", value: -2 },
  { name: "1.5", value: 1.5 },
  { name: "NaN", value: NaN },
  { name: "Infinity", value: Infinity },
  { name: "2 ** 53", value: 2 ** 53 },
  { name: '"4"', value: "4" },
  { name: "null", value: null },
];

for (const entry of parsed) {
  test(`parseChildLimit ${entry.name}`, () => {
    if (!entry.limit) {
      assert.throws(() => parseChildLimit(entry.value), INVALID);
      return;
    }
    assert.deepEqual(parseChildLimit(entry.value), entry.limit);
  });
}

test("an omitted field is the capped default of 4, not the built-in 6", () => {
  assert.deepEqual(OMITTED_CHILD_LIMIT, { kind: "capped", max: 4 });
  assert.equal(parseChildLimit(undefined), OMITTED_CHILD_LIMIT);
});

test("admission and the reported limit follow the kind, never the wire numbers", () => {
  const off = parseChildLimit(0);
  const one = parseChildLimit(1);
  const sixtyFive = parseChildLimit(65);
  const open = parseChildLimit(-1);
  assert.equal(allows(off, 0), false);
  assert.equal(allows(off, 1), false);
  assert.equal(allows(one, 1), true);
  assert.equal(allows(one, 2), false);
  assert.equal(allows(sixtyFive, 65), true);
  assert.equal(allows(sixtyFive, 66), false);
  assert.equal(allows(open, 0), true);
  assert.equal(allows(open, 100), true);
  assert.equal(reportedLimit(off), 0);
  assert.equal(reportedLimit(one), 1);
  assert.equal(reportedLimit(sixtyFive), 65);
  assert.equal(reportedLimit(open), "unlimited");
  assert.deepEqual(capacityOf(off, 2, 3), { limit: 0, live: 2, reserved: 3, available: 0 });
  assert.deepEqual(capacityOf(parseChildLimit(4), 1, 1), { limit: 4, live: 1, reserved: 1, available: 2 });
  assert.deepEqual(capacityOf(parseChildLimit(4), 3, 2), { limit: 4, live: 3, reserved: 2, available: 0 });
  assert.deepEqual(capacityOf(open, 70, 4), { limit: "unlimited", live: 70, reserved: 4, available: Number.MAX_SAFE_INTEGER });
});

test("unlimited capacity stays finite and never reports -1 through JSON", () => {
  const round = JSON.parse(JSON.stringify(capacityOf(parseChildLimit(-1), 70, 4)));
  assert.equal(round.limit, "unlimited");
  assert.equal(Number.isFinite(round.available), true);
  assert.equal(round.available, Number.MAX_SAFE_INTEGER);
  assert.equal(JSON.stringify(round).includes("-1"), false);
});

test("available is 0 exactly when one more child is refused", () => {
  const limits = [parseChildLimit(0), parseChildLimit(1), parseChildLimit(4), parseChildLimit(Number.MAX_SAFE_INTEGER), parseChildLimit(-1)];
  const occupancies = [[0, 0], [1, 0], [0, 1], [3, 1], [4, 0], [2, 2], [100, 0]];
  for (const limit of limits) for (const [live, reserved] of occupancies) {
    const capacity = capacityOf(limit, live, reserved);
    const refused = !allows(limit, live + reserved + 1);
    assert.equal(capacity.available === 0, refused, JSON.stringify({ limit, live, reserved, capacity }));
    assert.equal(Number.isFinite(capacity.available), true);
    assert.notEqual(capacity.limit, -1);
    assert.equal(capacity.limit, reportedLimit(limit));
  }
});

test("every reported limit has a label, and a value the catalog cannot produce does not", () => {
  for (const value of [undefined, 0, 1, 65, Number.MAX_SAFE_INTEGER, -1]) {
    const reported = reportedLimit(parseChildLimit(value));
    assert.notEqual(limitLabel(reported), undefined, String(value));
    assert.notEqual(reported, -1);
  }
  assert.equal(limitLabel("unlimited"), "no child limit");
  assert.equal(limitLabel(0), "max 0 children");
  assert.equal(limitLabel(6), "max 6 children");
  assert.equal(limitLabel(-1), undefined);
  assert.equal(limitLabel(1.5), undefined);
  assert.equal(limitLabel("4"), undefined);
  assert.equal(limitLabel(null), undefined);
});

const model = { provider: "test", id: "model", input: ["text"], contextWindow: 1, maxTokens: 1, cost: {}, thinkingLevels: ["high"] };
const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const until = async (check: () => boolean) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 15000) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

async function policyDir(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "child-limit-"));
  const agent = join(root, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "subagents.json"), JSON.stringify({
    version: 1, models: [{ id: "test/model:high" }], tools: ["read", "bash"], workingDirectories: ["."], ...extra,
  }));
  const environment = {
    cwd: root, agentDir: agent, projectTrusted: true, guardPath: join(root, "guard.mjs"),
    models: () => [model], tools: () => ["read", "bash"],
  };
  return { root, environment, policy: () => new SubagentPolicy(environment), async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

test("an invalid maxChildren keeps the policy error, and a deliberate 0 does not", async () => {
  const invalid = await policyDir({ maxChildren: "4" });
  const off = await policyDir({ maxChildren: 0 });
  try {
    const broken = invalid.policy();
    assert.match(broken.error ?? "", INVALID);
    assert.equal(broken.config, undefined);
    assert.equal(broken.catalog().maxChildren, 0);
    assert.match(broken.catalog().error ?? "", /Invalid subagent policy/);
    const disabled = off.policy();
    assert.equal(disabled.error, undefined);
    assert.equal(disabled.catalog().error, undefined);
    assert.equal(disabled.catalog().spawnEnabled, false);
    assert.equal(disabled.catalog().maxChildren, 0);
  } finally {
    await invalid.cleanup();
    await off.cleanup();
  }
});

test("maxChildren 0 and an empty model list both fail resume through compile", { timeout: 20000 }, async () => {
  const fixturePolicy = await policyDir();
  let running: SubagentManager | undefined;
  try {
    let policy = fixturePolicy.policy();
    assert.equal(policy.catalog().spawnEnabled, true);
    const manager = new SubagentManager(join(fixturePolicy.root, "manager"), undefined, undefined, parseChildLimit(1), (config, depth) => {
      if (!config.selection) return config;
      return policy.compile(config.cwd, config.selection, depth);
    });
    running = manager;
    const spawn = (name: string) => manager.spawn({
      name, task: "remember", cwd: fixturePolicy.root, executable: process.execPath, executableArgs: [fixture],
    });
    const closed = await spawn("closed");
    await until(() => manager.get(closed.id).status === "idle");
    await manager.close(closed.id);
    manager.get(closed.id).config.selection = { model: "test/model:high", tools: ["read"] };
    const live = await spawn("live");
    await until(() => manager.get(live.id).status === "idle");

    await writeFile(join(fixturePolicy.root, "agent", "subagents.json"), JSON.stringify({
      version: 1, models: [{ id: "test/model:high" }], tools: ["read", "bash"], workingDirectories: ["."], maxChildren: 0,
    }));
    policy = fixturePolicy.policy();
    assert.equal(policy.catalog().spawnEnabled, false);
    assert.equal(policy.catalog().error, undefined);
    assert.equal(policy.catalog().maxChildren, 0);
    await assert.rejects(() => manager.resume(closed.id), /No spawnable configuration/);

    await writeFile(join(fixturePolicy.root, "agent", "subagents.json"), JSON.stringify({
      version: 1, models: [], tools: ["read", "bash"], workingDirectories: ["."],
    }));
    policy = fixturePolicy.policy();
    assert.equal(policy.catalog().spawnEnabled, false);
    assert.equal(policy.catalog().error, undefined);
    assert.equal(policy.catalog().maxChildren, 4);
    await assert.rejects(() => manager.resume(closed.id), /No spawnable configuration/);
  } finally {
    await running?.shutdown();
    await fixturePolicy.cleanup();
  }
});

test("workflow concurrency 64 authorizes under no limit, fails under a cap of 3, and off fails compile first", async () => {
  const fixturePolicy = await policyDir({ maxChildren: -1 });
  try {
    const def = parseWorkflow({
      version: 1, name: "cap", cwd: fixturePolicy.root,
      limits: { concurrency: 64, maxAttempts: 1, timeoutSeconds: 30 },
      steps: [{ id: "work", kind: "task", worker: { model: "test/model:high", tools: ["read"] }, instructions: "go" }],
    });
    authorizeWorkflow(def, fixturePolicy.policy());
    await writeFile(join(fixturePolicy.root, "agent", "subagents.json"), JSON.stringify({
      version: 1, models: [{ id: "test/model:high" }], tools: ["read", "bash"], workingDirectories: ["."], maxChildren: 3,
    }));
    assert.throws(() => authorizeWorkflow(def, fixturePolicy.policy()), /Workflow concurrency exceeds policy maxChildren/);
    await writeFile(join(fixturePolicy.root, "agent", "subagents.json"), JSON.stringify({
      version: 1, models: [{ id: "test/model:high" }], tools: ["read", "bash"], workingDirectories: ["."], maxChildren: 0,
    }));
    assert.throws(() => authorizeWorkflow(def, fixturePolicy.policy()), /No spawnable configuration/);
  } finally {
    await fixturePolicy.cleanup();
  }
});

test("an unlimited manager admits a reservation the old cap would refuse, and its capacity stays finite in JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-limit-open-"));
  try {
    const manager = new SubagentManager(dir, undefined, undefined, parseChildLimit(-1));
    assert.ok(manager.reserveSlots(100));
    const round = JSON.parse(JSON.stringify(manager.capacity()));
    assert.equal(round.limit, "unlimited");
    assert.equal(Number.isFinite(round.available), true);
    assert.equal(round.available > 0, true);
    assert.equal(round.reserved, 100);
    assert.equal(JSON.stringify(round).includes("-1"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a full cap refuses one more child without throwing, and off refuses even an empty tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-limit-full-"));
  try {
    const capped = new SubagentManager(dir, undefined, undefined, parseChildLimit(1));
    assert.equal(capped.capacity().available, 1);
    assert.ok(capped.reserveSlots(1));
    assert.equal(capped.capacity().available, 0);
    assert.equal(capped.reserveSlots(1), undefined);
    const off = new SubagentManager(join(dir, "off"), undefined, undefined, parseChildLimit(0));
    assert.equal(off.capacity().available, 0);
    assert.equal(off.capacity().limit, 0);
    assert.throws(() => off.reserveSlots(1), /Spawning is disabled by policy/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a reservation that can never fit throws instead of polling", { timeout: 1000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-limit-slots-"));
  try {
    const manager = new SubagentManager(dir, undefined, undefined, parseChildLimit(1));
    assert.throws(() => manager.reserveSlots(2), (thrown: unknown) => {
      const message = thrown instanceof Error ? thrown.message : "";
      assert.match(message, /Live-child limit \(1\) cannot fit 2 children/);
      assert.doesNotMatch(message, /Live-child limit \(\d+\) reached;/);
      return true;
    });
    assert.equal(manager.capacity().reserved, 0);
    const host = managerWorkflowHost(manager, () => { throw new Error("policy should not be read"); });
    const jobs = [0, 1].map(step => ({
      step: String(step), workflow: "w", cwd: dir, worker: { model: "test/model:high", tools: [] as string[] },
      instructions: "go", candidate: dir, inputs: {}, onChild() {}, onActivity() {},
    }));
    await assert.rejects(host.agents(jobs, [], new AbortController().signal), /cannot fit 2 children/);
    assert.equal(manager.capacity().reserved, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
