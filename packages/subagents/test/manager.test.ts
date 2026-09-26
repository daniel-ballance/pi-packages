import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SubagentManager, type Notice } from "../src/manager.js";
import { formatAgentListing } from "../src/usage.js";
import { JsonlDecoder, RpcChild } from "../src/rpc.js";
import { managerWorkflowHost, type AgentJob } from "../src/workflow-host.js";
import type { SubagentPolicy } from "../src/policy.js";
const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
async function setup(limit = 4) {
  const dir = await mkdtemp(join(tmpdir(), "subagent-test-"));
  const notices: Notice[] = [];
  const costs: number[] = [];
  const manager = new SubagentManager(dir, n => notices.push(n), () => costs.push(manager.overview().totals.reportedCost), limit);
  const spawn = (task: string) => manager.spawn({ name: task, task, cwd: dir, executable: process.execPath, executableArgs: [fixture] });
  return { dir, manager, spawn, notices, costs, async cleanup() { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); } };
}

test("JSONL framing preserves Unicode separators and split records", () => {
  const packets: unknown[] = [];
  const decoder = new JsonlDecoder(packet => packets.push(packet));
  decoder.push('{"text":"a\u2028b\u2029');
  decoder.push('c"}\r\n\n{"n":2}\n');
  assert.deepEqual(packets, [{ text: "a\u2028b\u2029c" }, { n: 2 }]);
  assert.throws(() => new JsonlDecoder(() => {}, 8).push("123456789"), /exceeded/);
});

test("UI response transport awaits stdin write callback errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-rpc-write-"));
  const rpc = new RpcChild({
    executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: dir, env: process.env,
    event() {}, stderr() {}, exit() {},
  });
  const stdin = rpc.child.stdin as typeof rpc.child.stdin & { write: (...args: any[]) => boolean };
  const originalWrite = stdin.write;
  try {
    stdin.write = ((_chunk: string, callback: (error?: Error | null) => void) => {
      setImmediate(() => callback(new Error("simulated stdin failure")));
      return true;
    }) as typeof stdin.write;
    await assert.rejects(rpc.respond({ type: "extension_ui_response", id: "ui-1", confirmed: false }), /simulated stdin failure/);
  } finally {
    stdin.write = originalWrite;
    await rpc.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel children, incremental read, follow-up and usage", async () => {
  const s = await setup();
  try {
    const [a, b] = await Promise.all([s.spawn("alpha"), s.spawn("beta")]);
    assert.notEqual(a.id, b.id);
    const settled = await s.manager.wait([a.id, b.id], "all", 2000);
    assert.equal(settled.timedOut, false);
    assert.equal(settled.agents.every(a => a.status === "idle"), true);
    const first = s.manager.read(a.id);
    assert.ok(first.updates.some(u => u.text === "1:alpha"));
    assert.equal(s.manager.read(a.id).updates.length, 0);
    await s.manager.send(a.id, "follow-up");
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "2:follow-up"));
    assert.equal(s.notices.filter(n => n.kind === "completed").length, 3);
    assert.equal(s.manager.read(a.id, 0).gap, false);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((s.manager.get(a.id).usage as { userMessages: number }).userMessages, 2);
  } finally { await s.cleanup(); }
});

test("listing keeps footer cache-hit and auto-compaction across usage refresh", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("footer-stats");
    await s.manager.wait([a.id], "all", 2000);
    await s.manager.refreshUsageSnapshots();
    const usage = s.manager.get(a.id).usage as { cacheHitRate?: number; autoCompaction?: boolean };
    assert.equal(usage.autoCompaction, true);
    assert.equal(usage.cacheHitRate, (300 / 420) * 100);
    assert.equal(formatAgentListing(s.manager.list().find(agent => agent.id === a.id)!),
      `${a.id} · footer-stats · idle · test/fake:medium · 1 turn · ↑1.2k ↓340 R12k W800 CH71.4% 12.4%/272k (auto)`);
  } finally { await s.cleanup(); }
});

test("usage and footer refresh before a multi-turn child settles, without double counting", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("live-usage");
    const deadline = Date.now() + 2000;
    while ((s.manager.get(a.id).usage as { cost?: number })?.cost !== 0.125 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(s.manager.get(a.id).status, "working");
    assert.equal((s.manager.get(a.id).usage as { assistantMessages: number }).assistantMessages, 1);
    assert.equal(s.manager.overview().totals.reportedCost, 0.125);
    assert.ok(s.costs.includes(0.125), "UI change callback receives mid-run cost");
    await s.manager.close(a.id);
    assert.equal(s.manager.overview().totals.reportedCost, 0.25);
  } finally { await s.cleanup(); }
});

test("acceptance before agent_start cannot cause a premature idle result", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("accept-before-start");
    assert.equal(a.status, "working");
    assert.equal((await s.manager.wait([a.id], "all", 0)).timedOut, true);
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "late start finished"));
  } finally { await s.cleanup(); }
});

test("abort retains process, redirection works; resuming a live child must not close it", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("slow initial");
    const pid = a.pid;
    await assert.rejects(s.manager.resume(a.id), /already has a process/);
    assert.equal(s.manager.get(a.id).pid, pid);
    assert.equal((await s.manager.wait([a.id], "all", 0)).timedOut, true);
    await assert.rejects(s.manager.send(a.id, "unqualified"), /Already working/);
    await s.manager.abort(a.id);
    assert.equal(s.manager.get(a.id).status, "idle");
    assert.equal(s.manager.get(a.id).pid, pid);
    await s.manager.send(a.id, "redirect");
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "2:redirect"));
    await s.manager.close(a.id);
    await s.manager.close(a.id);
    assert.equal(s.manager.get(a.id).status, "stopped");
    assert.throws(() => process.kill(pid!, 0), /ESRCH/);
  } finally { await s.cleanup(); }
});

test("existing manager state permissions are repaired on reopen", { skip: process.platform === "win32" }, async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    const a = await s.spawn("privacy");
    await s.manager.wait([a.id], "all", 2000);
    await s.manager.shutdown();
    const registry = join(s.dir, "registry.json");
    await chmod(s.dir, 0o777); await chmod(registry, 0o666);
    restored = new SubagentManager(s.dir);
    assert.equal((await stat(s.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(registry)).mode & 0o777, 0o600);
  } finally { await restored?.shutdown(); await s.cleanup(); }
});

test("dangling registry temp and log symlinks are rejected before creating their targets", { skip: process.platform === "win32" }, async () => {
  const s = await setup();
  const registryTarget = `${s.dir}-registry-target`, logTarget = `${s.dir}-log-target`;
  try {
    await symlink(registryTarget, join(s.dir, "registry.json.tmp"));
    assert.throws(() => s.manager.markNoticesDelivered([]), /Unsafe subagent state path/);
    await assert.rejects(access(registryTarget), error => (error as NodeJS.ErrnoException).code === "ENOENT");
    await rm(join(s.dir, "registry.json.tmp"), { force: true });

    const child = await s.spawn("privacy-log");
    await s.manager.wait([child.id], "all", 2000);
    await s.manager.shutdown();
    await rm(s.manager.get(child.id).logFile, { force: true });
    await symlink(logTarget, s.manager.get(child.id).logFile);
    assert.throws(() => new SubagentManager(s.dir), /Unsafe subagent state path/);
    await assert.rejects(access(logTarget), error => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(registryTarget, { force: true }); await rm(logTarget, { force: true }); await s.cleanup();
  }
});

test("shutdown restores stopped metadata and resumes the saved conversation", async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    const a = await s.spawn("alpha");
    await s.manager.wait([a.id], "all", 2000);
    await s.manager.shutdown();
    restored = new SubagentManager(s.dir);
    assert.equal(restored.get(a.id).status, "stopped");
    assert.equal(restored.get(a.id).pid, undefined);
    await restored.resume(a.id, "remember");
    await restored.wait([a.id], "all", 2000);
    assert.ok(restored.read(a.id).updates.some(u => u.text === "2:remember"));
  } finally { await restored?.shutdown(); await s.cleanup(); }
});

test("dialog responses mutate pending UI only after transport queues the write", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("ui");
    const state = await s.manager.wait([a.id], "all", 2000);
    assert.equal(state.needsInput, true);
    assert.equal(s.manager.read(a.id).uiRequests[0].id, "ui-1");
    const child = (s.manager as unknown as { children: Map<string, { respond(packet: Record<string, unknown>): Promise<void> }> }).children.get(a.id)!;
    const originalRespond = child.respond.bind(child);
    let rejectWrite: ((error: Error) => void) | undefined;
    child.respond = () => new Promise((_resolve, reject) => { rejectWrite = reject; });
    const pending = s.manager.respond(a.id, "ui-1", { confirmed: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.manager.get(a.id).status, "waiting_input");
    assert.equal(s.manager.get(a.id).uiRequests[0].id, "ui-1");
    await assert.rejects(s.manager.respond(a.id, "ui-1", { cancelled: true }), /already being submitted/);
    rejectWrite!(new Error("simulated write failure"));
    await assert.rejects(pending, /simulated write failure/);
    assert.equal(s.manager.get(a.id).status, "waiting_input");
    assert.equal(s.manager.get(a.id).uiRequests[0].id, "ui-1");
    child.respond = originalRespond;
    const delivered = await s.manager.respond(a.id, "ui-1", { confirmed: false });
    assert.deepEqual(delivered.responseDelivery, { transport: "queued", receipt: "unconfirmed" });
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "confirmed=false"));
    await assert.rejects(s.manager.respond(a.id, "ui-1", { cancelled: true }), /Unknown/);
  } finally { await s.cleanup(); }
});

test("failed runs stay addressable; crashes and bad protocol are reported", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("error");
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.get(a.id).status, "failed");
    await s.manager.send(a.id, "recover");
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.get(a.id).status, "idle");
    await assert.rejects(s.spawn("crash"), /Child exited/);
    await assert.rejects(s.spawn("malformed"), /JSON|Unexpected/);
  } finally { await s.cleanup(); }
});

test("concurrency, reserved flags, env persistence, and cancelled waits", async () => {
  const s = await setup(1);
  try {
    const a = await s.manager.spawn({ name: "slow", task: "slow", cwd: s.dir, executable: process.execPath, executableArgs: [fixture], env: { TEST_SECRET: "never-persist-me" } });
    await assert.rejects(s.spawn("over limit"), /limit/);
    const signal = AbortSignal.abort();
    await assert.rejects(s.manager.wait([a.id], "all", 1000, signal), /abort/i);
    assert.equal(s.manager.get(a.id).status, "working");
    const registry = await readFile(join(s.dir, "registry.json"), "utf8");
    assert.equal(registry.includes("never-persist-me"), false);
    await s.manager.close(a.id);
    await assert.rejects(s.manager.resume(a.id), /environment overrides/);
    await assert.rejects(s.manager.spawn({ name: "bad", task: "x", cwd: s.dir, cliArgs: ["--no-session"] }), /manager-owned/);
  } finally { await s.cleanup(); }
});

function workflowJobs(directory: string): AgentJob[] {
  return ["a", "b"].map(step => ({
    step, workflow: "workflow-race", cwd: directory, worker: { model: "test/fake:medium", tools: [] },
    instructions: step, candidate: join(directory, `candidate-${step}`), inputs: {},
    onChild() {}, onActivity() {},
  }));
}

function workflowPolicy(): SubagentPolicy {
  return { compile: (cwd: string) => ({ cwd, executable: process.execPath, executableArgs: [fixture] }) } as unknown as SubagentPolicy;
}

test("workflow group reservation blocks a manual spawn between sequential members", async () => {
  const s = await setup(2);
  const originalSpawn = s.manager.spawn.bind(s.manager);
  let firstStarted!: () => void, continueGroup!: () => void;
  const first = new Promise<void>(resolve => { firstStarted = resolve; });
  const gate = new Promise<void>(resolve => { continueGroup = resolve; });
  let workflowSpawns = 0;
  s.manager.spawn = async (options, reservation) => {
    const child = await originalSpawn(options, reservation);
    if (options.workflow && ++workflowSpawns === 1) { firstStarted(); await gate; }
    return child;
  };
  const run = managerWorkflowHost(s.manager, workflowPolicy).agents(workflowJobs(s.dir), [], new AbortController().signal);
  try {
    await first;
    await assert.rejects(s.spawn("manual-racer"), /Live-child limit/);
    assert.equal(s.manager.list().filter(record => record.pid).length, 1);
    continueGroup();
    assert.equal((await run).length, 2);
    assert.equal(s.manager.list().filter(record => record.pid).length, 0);
  } finally {
    continueGroup();
    await run.catch(() => {});
    s.manager.spawn = originalSpawn;
    await s.cleanup();
  }
});

test("cancelled workflow group releases unused reservation and closes partial setup", async () => {
  const s = await setup(2);
  const originalSpawn = s.manager.spawn.bind(s.manager);
  let firstStarted!: () => void, continueGroup!: () => void;
  const first = new Promise<void>(resolve => { firstStarted = resolve; });
  const gate = new Promise<void>(resolve => { continueGroup = resolve; });
  let workflowSpawns = 0;
  s.manager.spawn = async (options, reservation) => {
    const child = await originalSpawn(options, reservation);
    if (options.workflow && ++workflowSpawns === 1) { firstStarted(); await gate; }
    return child;
  };
  const controller = new AbortController();
  const run = managerWorkflowHost(s.manager, workflowPolicy).agents(workflowJobs(s.dir), [], controller.signal);
  try {
    await first;
    controller.abort();
    continueGroup();
    await assert.rejects(run, /abort/i);
    assert.equal(workflowSpawns, 1);
    assert.equal(s.manager.list().filter(record => record.pid).length, 0);
    const manual = await s.spawn("capacity-restored");
    assert.ok(manual.pid);
  } finally {
    continueGroup();
    await run.catch(() => {});
    s.manager.spawn = originalSpawn;
    await s.cleanup();
  }
});
